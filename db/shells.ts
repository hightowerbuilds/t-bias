import { desc, eq } from "npm:drizzle-orm";
import { db } from "./client.ts";
import { shells } from "./schema.ts";

export async function recordShellSpawn(
  paneId: number,
  pid: number | undefined,
  command: string,
  cwd?: string,
): Promise<void> {
  await db.insert(shells).values({
    paneId,
    pid: pid ?? null,
    command,
    cwd: cwd ?? null,
    status: "running",
    startedAt: Date.now(),
  });
}

export async function recordShellExit(
  paneId: number,
  exitCode?: number,
): Promise<void> {
  const rows = await db
    .select({ id: shells.id })
    .from(shells)
    .where(eq(shells.paneId, paneId))
    .orderBy(desc(shells.startedAt))
    .limit(1);

  const id = rows[0]?.id;
  if (id == null) return;

  await db
    .update(shells)
    .set({
      status: exitCode === 0 || exitCode == null ? "exited" : "crashed",
      exitedAt: Date.now(),
    })
    .where(eq(shells.id, id));
}
