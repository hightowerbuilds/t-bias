// Post-process a `deno desktop` bundle so the Rust PTY sidecar is shipped
// alongside the compiled Deno entrypoint and re-signed.

import { dirname, join } from "jsr:@std/path";

const ROOT = Deno.cwd();
const DENO_JSON_PATH = join(ROOT, "deno.json");
const SIDECAR_SRC = join(ROOT, "sidecar", "target", "release", "tbias-pty");

interface DenoDesktopOutput {
  macos?: string;
}

async function readDesktopOutput(): Promise<string> {
  const text = await Deno.readTextFile(DENO_JSON_PATH);
  const json = JSON.parse(text);
  const output: DenoDesktopOutput | undefined = json?.desktop?.output;
  if (!output?.macos) {
    throw new Error("deno.json desktop.output.macos is missing");
  }
  return join(ROOT, output.macos);
}

async function ensureSidecarBuilt() {
  try {
    const stat = await Deno.stat(SIDECAR_SRC);
    if (stat.isFile) return;
  } catch { /* missing */ }

  console.log("[package] sidecar binary missing; building with cargo...");
  const build = new Deno.Command("cargo", {
    args: ["build", "--release"],
    cwd: join(ROOT, "sidecar"),
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await build.output();
  if (!success) throw new Error("cargo build --release failed");
}

async function copySidecar(appPath: string) {
  const destDir = join(appPath, "Contents", "MacOS");
  const dest = join(destDir, "tbias-pty");

  await Deno.mkdir(destDir, { recursive: true });
  await Deno.copyFile(SIDECAR_SRC, dest);

  // Make sure the binary is executable (Deno desktop already codesigns its own
  // binaries; we need the helper to be runnable before re-signing).
  await Deno.chmod(dest, 0o755);
  console.log(`[package] copied sidecar → ${dest}`);
}

async function reSign(appPath: string) {
  console.log("[package] re-signing bundle...");
  const sign = new Deno.Command("codesign", {
    args: ["--force", "--deep", "--sign", "-", appPath],
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await sign.output();
  if (!success) throw new Error("codesign failed");
  console.log("[package] bundle signed");
}

async function main() {
  const appPath = await readDesktopOutput();
  console.log(`[package] app bundle: ${appPath}`);

  await ensureSidecarBuilt();
  await copySidecar(appPath);
  await reSign(appPath);

  console.log("[package] done");
}

main().catch((e) => {
  console.error(`[package] error: ${e.message}`);
  Deno.exit(1);
});
