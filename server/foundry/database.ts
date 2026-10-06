import { Pool, types } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Unsafe database revision");
  return number;
});

export type KnowledgeDatabase = {
  all<T = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<T | undefined>;
  run(sql: string, ...values: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
};

export async function createFoundryDatabase(url: string, schema: string, encryptionKey: string) {
  if (!/^fiq_[a-z0-9_]{1,40}$/.test(schema)) throw new Error("Use an isolated fiq_ database schema");
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error("ENCRYPTION_KEY requires 64 hex characters");
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000,
    options: `-c search_path=${schema},public` });
  pool.on("error", () => console.error("Foundry database connection unavailable"));
  const context = new AsyncLocalStorage<PoolClient>();
  const parameterize = (sql: string) => {
    let count = 0;
    return sql.replace(/'[^']*'|\?/g, (match) => match === "?" ? `$${++count}` : match);
  };
  const all = async <T = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<T[]> =>
    (await (context.getStore() ?? pool).query(parameterize(sql), values)).rows;
  const store: KnowledgeDatabase = {
    all,
    one: async <T = Record<string, unknown>>(sql: string, ...values: unknown[]) => (await all<T>(sql, ...values))[0],
    run: async (sql, ...values) => ({ changes: (await (context.getStore() ?? pool).query(parameterize(sql), values)).rowCount ?? 0 }),
    async transaction<T>(fn: () => T | Promise<T>) {
      if (context.getStore()) return fn();
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const result = await context.run(connection, fn);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally { connection.release(); }
    },
  };
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await store.transaction(async () => {
      await store.run("SELECT pg_advisory_xact_lock(hashtext(?))", `jevbox-${schema}-migrate`);
      await store.run("CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY)");
      const directory = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(directory)).filter((name) => /^\d+-.*\.sql$/.test(name)).sort()) {
        const version = Number(name.split("-")[0]);
        if (await store.one("SELECT version FROM schema_migrations WHERE version=?", version)) continue;
        await store.run(await readFile(new URL(name, directory), "utf8"));
        await store.run("INSERT INTO schema_migrations(version) VALUES(?)", version);
      }
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const key = Buffer.from(encryptionKey, "hex");
  return {
    ...store,
    pool,
    schema,
    executeSql: (sql: string, values?: unknown[]) => (context.getStore() ?? pool).query(sql, values),
    encrypt(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString("base64");
    },
    decrypt(value: string) {
      const bytes = Buffer.from(value, "base64");
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
    },
    close: () => pool.end(),
  };
}
