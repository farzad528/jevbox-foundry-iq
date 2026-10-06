import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 });
  try {
    if (process.platform === "win32") {
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true });
      const sid = stdout.trim();
      assert.match(sid, /^S-1-[\d-]+$/);
      await execute("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true });
    }
  } catch {
    await rm(path, { recursive: true, force: false });
    throw new Error("Could not protect the exclusively owned PostgreSQL test directory");
  }
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function createPrivatePostgres(bin: string) {
  const executable = (name: string) => join(resolve(bin), process.platform === "win32" ? `${name}.exe` : name);
  for (const name of ["initdb", "pg_ctl", "postgres"]) assert((await stat(executable(name))).isFile(), `${name} executable required`);
  const base = resolve(".data", "foundry-postgres");
  await mkdir(base, { recursive: true });
  const parent = await realpath(base);
  const path = join(parent, `run-${randomUUID()}`);
  await privateDirectory(path);
  const owned = await realpath(path);
  assert.equal(dirname(owned), parent);
  assert.match(basename(owned), /^run-[0-9a-f-]{36}$/);
  const data = join(owned, "cluster");
  const passwordFile = join(owned, "init-password");
  const password = randomBytes(32).toString("base64url");
  const username = userInfo().username;
  let port: number | undefined;
  let ownedPid: number | undefined;
  let started = false;
  let closed = false;
  const run = async (name: string, args: string[]) => {
    try {
      await execute(executable(name), args, { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    } catch {
      // Child command/output can include connection details; never propagate it to test logs.
      throw new Error(`Private PostgreSQL ${name} failed; no shared instance was changed`);
    }
  };
  const stop = async () => {
    if (closed) return;
    const pidFile = join(data, "postmaster.pid");
    let pid: number | undefined;
    try {
      const lines = (await readFile(pidFile, "utf8")).split(/\r?\n/);
      pid = Number(lines[0]);
      assert(Number.isInteger(pid) && pid > 0);
      assert.equal(resolve(lines[1]), resolve(data), "Only the exact owned cluster may be stopped");
      if (ownedPid !== undefined) assert.equal(pid, ownedPid, "Only the originally started PostgreSQL PID may be stopped");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (pid !== undefined) {
      await run("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
      await assert.rejects(readFile(pidFile), { code: "ENOENT" });
      const deadline = Date.now() + 5000;
      let exited = false;
      do {
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          exited = true;
        }
        if (!exited) await delay(50);
      } while (!exited && Date.now() < deadline);
      assert(exited, "The exact owned PostgreSQL PID must exit before its directory is removed");
      started = false;
    } else {
      assert(!started, "A started cluster must retain its ownership PID until stopped");
    }
    if (pid !== undefined) await new Promise<void>((resolve, reject) => {
      assert(port !== undefined);
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); reject(new Error("Owned PostgreSQL listener did not stop")); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED") resolve(); else reject(error);
      });
    });
    assert.equal(await realpath(owned), owned);
    assert.equal(dirname(owned), parent);
    assert(owned.startsWith(parent + sep));
    const log = await readFile(join(owned, "postgres.log"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert(!log.includes(password) && !log.includes("postgresql://"), "Private cluster log must not disclose passwords or database URLs");
    await rm(owned, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 });
    await assert.rejects(stat(owned), { code: "ENOENT" });
    closed = true;
  };
  try {
    port = await unusedLoopbackPort();
    await writeFile(passwordFile, password + "\n", { mode: 0o600, flag: "wx" });
    await run("initdb", ["-D", data, "--encoding=UTF8", "--no-locale", "--username", username,
      "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--pwfile", passwordFile]);
    await rm(passwordFile);
    await appendFile(join(data, "postgresql.conf"), [
      "", "listen_addresses = '127.0.0.1'", `port = ${port}`, "password_encryption = 'scram-sha-256'",
      "log_connections = off", "log_disconnections = off", "log_statement = 'none'",
      "log_min_error_statement = panic", "log_error_verbosity = terse",
      ...(process.platform === "win32" ? [] : ["unix_socket_directories = ''"]), "",
    ].join("\n"));
    await writeFile(join(data, "pg_hba.conf"), "host all all 127.0.0.1/32 scram-sha-256\n", { mode: 0o600 });
    await run("pg_ctl", ["-D", data, "-l", join(owned, "postgres.log"), "-w", "-t", "30", "start"]);
    started = true;
    const lines = (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/);
    ownedPid = Number(lines[0]);
    assert(Number.isInteger(ownedPid) && ownedPid > 0);
    assert.equal(resolve(lines[1]), resolve(data));
    assert.equal(Number(lines[3]), port);
    const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
    url.username = username;
    url.password = password;
    return { url: url.toString(), username, data, directory: owned, port, pid: ownedPid, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
