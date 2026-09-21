#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir/app"
cargo fmt --check
cargo test --locked
cargo build --locked
if [[ "${1:-}" == --gui ]]; then
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/tbias-smoke.XXXXXX")"
  echo "Native smoke data: $smoke_dir"
  TBIAS_DATA_DIR="$smoke_dir" ./target/debug/t-bias --smoke-test 2>&1 | tee "$smoke_dir/smoke.log"
  rg -q NATIVE_SMOKE_OK "$smoke_dir/smoke.log"
fi
