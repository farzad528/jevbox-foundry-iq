import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function personalEnvironment(env: NodeJS.ProcessEnv = process.env, version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number), port = Number(env.PERSONAL_FILE_PORT ?? 4388);
  if (major < 24 || major === 24 && minor < 6) throw new Error("Node.js 24.6 or newer is required");
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4387) throw new Error("Choose a separate unprivileged personal port, not the guarded preview port");
  return { ...env, HOST: "127.0.0.1", PORT: String(port), APP_ORIGIN: `http://localhost:${port}`, JEVBOX_PROFILE: "personal-file" };
}
export async function launchPersonal() {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), ".."), env = personalEnvironment();
  const run = (program: string, args: string[]) => new Promise<number>((resolveExit, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (!existsSync(resolve(cwd, "node_modules", "tsx", "package.json")) || !existsSync(resolve(cwd, "node_modules", "@azure", "identity", "package.json"))) {
    const result = process.platform === "win32"
      ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npx --yes --package=pnpm@12.8.1 pnpm install --frozen-lockfile"])
      : await run("npx", ["--yes", "--package=pnpm@12.8.1", "pnpm", "install", "--frozen-lockfile"]);
    if (result) return result;
  }
  console.log(`Open ${env.APP_ORIGIN}. Personal File-KS workspace; Ctrl+C stops the app.`);
  console.log("Local picker and 3D are usable without Azure. No sign-in, upload, KB mutation or model call happens on launch.");
  return run(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "server/index.ts"]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  launchPersonal().then((code) => { process.exitCode = code; }).catch(() => { console.error("Personal launch failed; check Node, dependencies and private configuration"); process.exitCode = 1; });
