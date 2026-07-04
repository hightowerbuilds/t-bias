// Drizzle + node:sqlite client for t-bias.
//
// Drizzle doesn't ship a first-party node:sqlite driver, so we use the
// sqlite-proxy driver and bridge it to node:sqlite's synchronous API.

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { dirname, join } from "jsr:@std/path";
import { drizzle } from "npm:drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";

function appDataDir(): string {
  const home = Deno.env.get("HOME");
  const exe = Deno.execPath();

  // Detect a packaged Deno Desktop .app bundle on macOS.
  if (Deno.build.os === "darwin" && exe.includes(".app/Contents/MacOS/") && home) {
    return join(home, "Library", "Application Support", "com.tbias.app");
  }

  // Dev / non-packaged: keep the database in the project root.
  return join(Deno.cwd(), "data");
}

const DATA_DIR = appDataDir();
const DB_PATH = join(DATA_DIR, "t-bias.db");

await Deno.mkdir(DATA_DIR, { recursive: true });

const sqlite = new DatabaseSync(DB_PATH);

// Synchronous bridge from node:sqlite to Drizzle's sqlite-proxy driver.
//
// Drizzle's sqlite-proxy expects rows as arrays of raw column values ordered to
// match the SELECT, so we use `stmt.columns()` to map node:sqlite objects back
// into arrays.
const proxy = async (
  sql: string,
  params: unknown[],
  method: "run" | "all" | "get" | "values",
) => {
  const stmt: StatementSync = sqlite.prepare(sql);
  const values = params as SQLInputValue[];
  const columnNames = () => stmt.columns().map((c) => c.name);

  if (method === "run") {
    const result = stmt.run(...values);
    return { rows: [result] };
  }

  if (method === "get") {
    const row = stmt.get(...values) as Record<string, unknown> | undefined;
    if (!row) return { rows: [] };
    return { rows: [columnNames().map((name) => row[name])] };
  }

  const rows = stmt.all(...values) as Record<string, unknown>[];
  const names = columnNames();
  const asArrays = rows.map((row) => names.map((name) => row[name]));

  if (method === "values") {
    return { rows: asArrays };
  }

  // method === "all"
  return { rows: asArrays };
};

export const db = drizzle(proxy, { schema });
export { sqlite };
