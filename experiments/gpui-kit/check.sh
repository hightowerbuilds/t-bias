#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
case "${1:-}" in
  ""|--smoke) ;;
  *) echo 'Usage: ./check.sh [--smoke]' >&2; exit 2 ;;
esac
cargo fmt --check
cargo build --locked
# A second GPUI runtime or optional JS/webview layer would defeat this probe.
tree="$(cargo tree --locked --target x86_64-apple-darwin --prefix none)"
if printf '%s\n' "$tree" | rg -q '^(gpui v|gpui-shell |rquickjs |quickjs|gpui-wry |wry )'; then
  echo 'Unexpected legacy GPUI, JavaScript, or webview dependency' >&2
  exit 1
fi
if [[ "${1:-}" == --smoke ]]; then
  mkdir -p evidence
  ./target/debug/tbias-gpui-kit-probe --smoke 2>&1 | tee evidence/debug-smoke.log
  rg -q KIT_ACCEPTANCE_OK evidence/debug-smoke.log
  rg -q KIT_INPUT_SMOKE_OK evidence/debug-smoke.log
fi
