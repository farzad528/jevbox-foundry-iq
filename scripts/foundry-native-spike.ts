import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { spikeConfigSchema, fixedSpikeQuestions, runLiveNativeSpike } from "../server/foundry/spike";
import { createSpikeAuth } from "../server/foundry/spike-auth";
import { createServiceCredential, createDefinitionReadbackCredential } from "../server/foundry/service-credentials";
import type { DelegatedCredential } from "../server/foundry/credentials";

export function scheduleNativeSpikeDeadline(expiresAt: string, close: () => Promise<void>) {
  return setTimeout(() => {
    process.exitCode = 2;
    void close().catch(() => { process.exitCode = 2; });
  }, Date.parse(expiresAt) - Date.now());
}
export async function startNativeSpike(configFile: string, outputDirectory: string) {
  if (!basename(configFile).endsWith(".spike.local.json")) throw new Error("Ignored private spike configuration required");
  const config = spikeConfigSchema.parse(JSON.parse(await readFile(resolve(configFile), "utf8")));
  const questions = await fixedSpikeQuestions(config);
  if (!process.env.ENTRA_CLIENT_SECRET || !process.env.FOUNDRY_READER_SECRET || !process.env.FOUNDRY_PROJECT_SECRET ||
      (config.wrongTenant && !process.env.ENTRA_ADVERSE_CLIENT_SECRET) ||
      (config.definitionReadback && !process.env.FOUNDRY_DEFINITION_READER_SECRET)) throw new Error("Approved environment credentials unavailable");
  const directory = resolve(outputDirectory);
  if (basename(directory) !== "foundry-spike-private") throw new Error("Use a new dedicated foundry-spike-private output directory");
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error("Private output owner could not be verified");
    execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore", windowsHide: true });
  }
  const controller = new AbortController();
  const resources: { close(): Promise<void> }[] = [];
  const configForAuth = (tenantId: string, roster: string[], clientId: string, origin: string, secret: string) => ({
    tenantId, roster, clientId, clientSecret: secret, redirectUri: `${origin.replace(/\/$/, "")}/api/entra/callback`,
    encryptionKey: randomBytes(32).toString("hex"), cookieSecure: false, consentActivated: true,
  });
  let closing: Promise<void> | undefined;
  let foreign: (() => Promise<DelegatedCredential>) | undefined;
  let attempted = false;
  const nonce = randomUUID();
  const close = () => closing ??= (async () => {
    controller.abort();
    for (const resource of resources.reverse()) await resource.close();
  })();
  const timer = scheduleNativeSpikeDeadline(config.approval.expiresAt, close);
  const listen = async (app: express.Express, origin: string) => {
    const url = new URL(origin);
    app.use((_req, res) => res.status(404).send("Unavailable"));
    const server = app.listen(Number(url.port), "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    resources.push({ close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
  };
  const appFor = (origin: string) => {
    const app = express();
    app.disable("x-powered-by");
    app.use((req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
      if (req.get("Host") !== new URL(origin).host || controller.signal.aborted ||
          Date.now() >= Date.parse(config.approval.expiresAt)) { res.status(403).send("Operator boundary unavailable"); return; }
      next();
    });
    app.use(express.urlencoded({ extended: false, limit: "2kb" }));
    return app;
  };
  try {
    const primary = await createSpikeAuth(configForAuth(config.runtime.knowledge.tenantId, config.runtime.knowledge.roster,
      config.runtime.entraClientId, config.origin, process.env.ENTRA_CLIENT_SECRET),
    { signIn: config.approval.signIn, expiresAt: config.approval.expiresAt });
    resources.push(primary);
    if (config.wrongTenant) {
      const adverse = config.wrongTenant;
      const auxiliary = await createSpikeAuth(configForAuth(adverse.tenantId, adverse.roster, adverse.clientId,
        adverse.origin, process.env.ENTRA_ADVERSE_CLIENT_SECRET!),
      { signIn: adverse.approved, expiresAt: config.approval.expiresAt });
      resources.push(auxiliary);
      const app = appFor(adverse.origin);
      app.use("/api/entra", auxiliary.auth.router);
      app.get("/", async (req, res) => {
        try {
          const session = await auxiliary.auth.authenticate(req);
          if (session.identity.objectId !== adverse.expectedOid) { res.status(403).send("Exact adverse user required"); return; }
          foreign = () => auxiliary.auth.credentialForSession(session.sessionId);
          res.send("Approved adverse identity captured in memory only.");
        } catch { res.send('<a href="/api/entra/login">Sign in as the separately approved adverse user</a>'); }
      });
      await listen(app, adverse.origin);
    }
    const app = appFor(config.origin);
    app.use("/api/entra", primary.auth.router);
    app.get("/", async (req, res) => {
      try {
        await primary.auth.authenticate(req);
        res.send(`<p>Use separate browser profiles for both approved users. Sign-in alone is not proof.</p><form method="post" action="/verify"><input type="hidden" name="nonce" value="${nonce}"><button>Run the explicitly approved bounded native checks</button></form>`);
      } catch { res.send('<p>Bounded preactivation operator; the main app remains locked.</p><a href="/api/entra/login">Sign in with an approved user</a>'); }
    });
    app.post("/verify", async (req, res) => {
      if (req.get("Origin") !== new URL(config.origin).origin || req.body?.nonce !== nonce || attempted) {
        res.status(403).send("Explicit authenticated operator submission required"); return;
      }
      try {
        await primary.auth.authenticate(req);
        await primary.auth.credentialsForRoster();
      } catch { res.status(409).send("Both approved users must sign in using separate browser profiles."); return; }
      attempted = true;
      try {
        const report = await runLiveNativeSpike(config, { credentials: () => primary.auth.credentialsForRoster(),
          wrongTenantCredential: () => foreign?.() ?? Promise.resolve(undefined),
          reader: createServiceCredential(config.runtime, "reader"), project: createServiceCredential(config.runtime, "project"),
          definitions: config.definitionReadback
            ? createDefinitionReadbackCredential(config.runtime, config.definitionReadback.clientId) : undefined,
          questions }, controller.signal);
        await writeFile(join(directory, "report.native-proof.local.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
        process.exitCode = report.nativeProof && !controller.signal.aborted &&
          Date.now() < Date.parse(config.approval.expiresAt) ? 0 : 2;
        res.send(report.nativeProof ? "Live verification completed; review the private report before copying its proof into the private runtime." :
          "Verification is partial/failed. No activation-ready proof was produced. Inspect the private redacted observations.");
      } catch {
        process.exitCode = 2;
        await writeFile(join(directory, "report.native-proof.local.json"), JSON.stringify({
          schemaVersion: 1, status: "blocked", nativeProof: null, code: "operator-native-verification-failed",
        }), { flag: "wx", mode: 0o600 });
        res.status(502).send("Native verification failed; no proof was produced. Raw diagnostics and tokens are not exposed.");
      } finally { clearTimeout(timer); setImmediate(() => { void close().catch(() => { process.exitCode = 2; }); }); }
    });
    await listen(app, config.origin);
    return { origin: config.origin, close: async () => { clearTimeout(timer); await close(); } };
  } catch (error) { clearTimeout(timer); await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [config, output] = process.argv.slice(2);
  if (!config || !output) { console.error("Usage: node --import tsx scripts\\foundry-native-spike.ts <private.spike.local.json> <new foundry-spike-private directory>"); process.exitCode = 2; }
  else {
    try { const server = await startNativeSpike(config, output); console.log(`Approved bounded operator available at ${server.origin}; main application activation is unchanged.`); }
    catch { console.error("Preactivation refused: approved private configuration, exact synthetic evidence, credentials and private output are required."); process.exitCode = 2; }
  }
}
