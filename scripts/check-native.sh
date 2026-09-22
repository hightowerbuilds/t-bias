#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir/app"
cargo fmt --check
cargo test --locked
cargo build --locked
# Exactly one GPUI family and no optional JS/webview runtime on the Mac target.
tree="$(cargo tree --locked --target "$(rustc -vV | sed -n 's/^host: //p')" --prefix none)"
if printf '%s\n' "$tree" | rg -q '^(gpui v|gpui-shell |rquickjs |quickjs|gpui-wry |wry )'; then
  echo 'Unexpected legacy GPUI, JavaScript, or webview dependency' >&2
  exit 1
fi
if [[ "${1:-}" == --controller ]]; then
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/tbias-controller.XXXXXX")"
  echo "Controller smoke data: $smoke_dir"
  ./target/debug/t-bias --controller-probe "$smoke_dir/controller.png"
  TBIAS_DATA_DIR="$smoke_dir/app" ./target/debug/t-bias --controller-smoke 2>&1 | tee "$smoke_dir/controller.log"
  rg -q CONTROLLER_SMOKE_OK "$smoke_dir/controller.log"
fi
if [[ "${1:-}" == --gui || "${1:-}" == --activity ]]; then
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/tbias-smoke.XXXXXX")"
  echo "Native smoke data: $smoke_dir"
  if [[ "${1:-}" == --gui ]]; then
    TBIAS_DATA_DIR="$smoke_dir/terminal" ./target/debug/t-bias --smoke-test 2>&1 | tee "$smoke_dir/smoke.log"
    rg -q NATIVE_SMOKE_OK "$smoke_dir/smoke.log"
  fi
  ./target/debug/t-bias --activity-probe | tee "$smoke_dir/activity-probe.log"
  rg -q ACTIVITY_LIFECYCLE_OK "$smoke_dir/activity-probe.log"
  TBIAS_DATA_DIR="$smoke_dir/activity" ./target/debug/t-bias --activity-smoke 2>&1 | tee "$smoke_dir/activity.log"
  rg -q ACTIVITY_SMOKE_OK "$smoke_dir/activity.log"
  rg -q NAVIGATION_SMOKE_OK "$smoke_dir/activity.log"
fi

if [[ "${1:-}" == --kit ]]; then
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/tbias-kit.XXXXXX")"
  echo "Kit smoke data: $smoke_dir"
  TBIAS_DATA_DIR="$smoke_dir" ./target/debug/t-bias --kit-smoke 2>&1 | tee "$smoke_dir/kit.log"
  rg -q KIT_APP_SMOKE_OK "$smoke_dir/kit.log"
  rg -q KIT_TABLE_SMOKE_OK "$smoke_dir/kit.log"
fi
