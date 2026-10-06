import { PGlite, type Transaction } from "@electric-sql/pglite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import {
  createEntraAuth,
  type EntraAuthConfig,
  type EntraStore,
} from "./entra-auth";

const maximumApproval = 2 * 60 * 60_000;
const sqlError = () => new Error("Invalid spike authentication SQL parameters");
const closedError = () => new Error("Spike authentication store is closed");

function parameterize(sql: string, values: unknown[]) {
  let output = "";
  let parameters = 0;
  let i = 0;
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith("--", i)) {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
    } else if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw sqlError();
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      const escapes =
        quote === "'" &&
        /[eE]/.test(sql[i - 1] ?? "") &&
        !/[\p{L}\p{N}_$]/u.test(sql[i - 2] ?? "");
      let complete = false;
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === quote) {
          i++;
          if (sql[i] === quote) i++;
          else {
            complete = true;
            break;
          }
        } else i++;
      }
      if (!complete) throw sqlError();
    } else if (sql[i] === "$") {
      const boundary = !/[\p{L}\p{N}_$]/u.test(sql[i - 1] ?? "");
      const tag = boundary
        ? sql.slice(i).match(/^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u)?.[0]
        : undefined;
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw sqlError();
        i = end + tag.length;
      } else {
        if (boundary && /\d/.test(sql[i + 1] ?? "")) throw sqlError();
        i++;
      }
    } else if (
      sql[i] === "?" &&
      sql[i - 1] !== "@" &&
      sql[i + 1] !== "|" &&
      sql[i + 1] !== "&"
    ) {
      output += `$${++parameters}`;
      i++;
      continue;
    } else i++;
    output += sql.slice(start, i);
  }
  if (parameters !== values.length) throw sqlError();
  return output;
}

/**
 * Disposable auth reuse for a separately approved operator run, not main-app activation.
 * Construction is synchronous; the first store operation lazily initializes migration027.
 * The owner must enforce the approval deadline at HTTP/probe boundaries and call close().
 */
export function createSpikeAuth(
  config: EntraAuthConfig,
  approval: { signIn: boolean; expiresAt: string },
): {
  auth: ReturnType<typeof createEntraAuth>;
  close(): Promise<void>;
} {
  const now = Date.now();
  const deadline =
    typeof approval?.expiresAt === "string"
      ? Date.parse(approval.expiresAt)
      : NaN;
  if (
    approval?.signIn !== true ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline - now > maximumApproval
  )
    throw new Error(
      "Spike sign-in requires explicit approval with a future deadline within two hours",
    );

  const scopedConfig: EntraAuthConfig = { ...config };
  const transactions = new AsyncLocalStorage<Transaction>();
  let database: PGlite | undefined;
  let initialization: Promise<PGlite> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let active = 0;
  let drain: (() => void) | undefined;

  function initialize() {
    initialization ??= (async () => {
      const db = new PGlite();
      database = db;
      const migration = await readFile(
        new URL("../migrations/027-entra-sessions.sql", import.meta.url),
        "utf8",
      );
      await db.exec(migration);
      return db;
    })();
    return initialization;
  }

  async function operation<T>(fn: (db: PGlite) => Promise<T>) {
    if (closing) throw closedError();
    active++;
    try {
      const db = await initialize();
      if (closing) throw closedError();
      return await fn(db);
    } finally {
      active--;
      if (active === 0) drain?.();
    }
  }

  const store: EntraStore = {
    async one<T>(sql: string, ...values: unknown[]) {
      const statement = parameterize(sql, values);
      return operation(
        async (db) =>
          (await (transactions.getStore() ?? db).query<T>(statement, values))
            .rows[0],
      );
    },
    async run(sql: string, ...values: unknown[]) {
      const statement = parameterize(sql, values);
      return operation(async (db) => ({
        changes:
          (await (transactions.getStore() ?? db).query(statement, values))
            .affectedRows ?? 0,
      }));
    },
    async transaction<T>(fn: () => Promise<T>) {
      return operation(async (db) => {
        if (transactions.getStore()) return fn();
        return db.transaction((tx) => transactions.run(tx, fn));
      });
    },
  };
  const auth = createEntraAuth(scopedConfig, store);

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    scopedConfig.consentActivated = false;
    closePromise = (async () => {
      if (active > 0)
        await new Promise<void>((resolve) => {
          drain = resolve;
        });
      try {
        await database?.close();
      } catch {
        throw new Error("Spike authentication store could not be discarded");
      } finally {
        database = undefined;
        initialization = undefined;
        transactions.disable();
      }
    })();
    return closePromise;
  }
  return { auth, close };
}
