import { join, normalize } from "jsr:@std/path";

const ROOT = Deno.env.get("TBIAS_FS_ROOT") ?? Deno.cwd();

export function resolveSafe(subpath: string): string {
  const target = normalize(join(ROOT, normalize("/" + subpath)));
  const root = normalize(ROOT);
  if (!target.startsWith(root)) {
    throw new Error("path outside sandbox");
  }
  return target;
}

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export async function listDirectory(subpath: string): Promise<DirEntry[]> {
  const path = resolveSafe(subpath);
  const entries: DirEntry[] = [];
  for await (const entry of Deno.readDir(path)) {
    const type = entry.isDirectory
      ? "directory"
      : entry.isSymlink
      ? "symlink"
      : "file";
    entries.push({ name: entry.name, type });
  }
  entries.sort((a, b) => {
    const aDir = a.type === "directory" ? 0 : 1;
    const bDir = b.type === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function readTextFile(subpath: string): Promise<string> {
  const path = resolveSafe(subpath);
  return await Deno.readTextFile(path);
}
