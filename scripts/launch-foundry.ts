import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function launchEnvironment(env: NodeJS.ProcessEnv = process.env, nodeVersion = process.versions.node) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 6)) throw new Error("Install Node.js 24.6 or newer before launching Jevbox.");
  const port = Number(env.PORT ?? 4387);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be an unprivileged local port (1024-65535).");
  const origin = `http://localhost:${port}`;
  if (env.APP_ORIGIN && env.APP_ORIGIN !== origin) throw new Error(`This local launcher requires APP_ORIGIN=${origin}; it never exposes a hosted app.`);
  return { ...env, PORT: String(port), HOST: "127.0.0.1", APP_ORIGIN: origin, JEVBOX_PROFILE: "foundry-iq" };
}
export async function launch() {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = launchEnvironment();
  const run = (command: string, args: string[]) => new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
  if (!existsSync(resolve(cwd, "node_modules", "tsx", "package.json"))) {
    console.log("Installing the repository's pinned dependencies locally. No global installation or cloud provisioning.");
    const result = process.platform === "win32"
      ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npx --yes --package=pnpm@12.8.1 pnpm install --frozen-lockfile"])
      : await run("npx", ["--yes", "--package=pnpm@12.8.1", "pnpm", "install", "--frozen-lockfile"]);
    if (result !== 0) return result;
  }
  console.log(`Open ${env.APP_ORIGIN}. Keep this terminal open; Ctrl+C stops your app.`);
  console.log("Foundry IQ only. No SpiceDB, cloud provisioning, account connection or data import happens on launch.");
  return run(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/foundry-dev.ts"]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  launch().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Local launch failed");
    process.exitCode = 1;
  });
}
