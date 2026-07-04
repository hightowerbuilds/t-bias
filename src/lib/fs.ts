export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

export async function listDirectory(path: string): Promise<DirEntry[]> {
  const res = await fetch(`/api/fs/list?${new URLSearchParams({ path })}`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

export async function readTextFile(path: string): Promise<string> {
  const res = await fetch(`/api/fs/read?${new URLSearchParams({ path })}`);
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  const data = await res.json();
  return data.content as string;
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}
