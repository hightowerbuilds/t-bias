#!/usr/bin/env bash
# Separate, ad-hoc-signed local probe. Never replaces dist-native/t-bias.app.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
cargo build --release --locked
bundle="dist/GPUI Kit Probe.app"
mkdir -p "$bundle/Contents/MacOS"
cp target/release/tbias-gpui-kit-probe "$bundle/Contents/MacOS/tbias-gpui-kit-probe"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>GPUI Kit Probe</string>
<key>CFBundleIdentifier</key><string>com.tbias.gpui-kit-probe</string>
<key>CFBundleExecutable</key><string>tbias-gpui-kit-probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
plutil -lint "$bundle/Contents/Info.plist"
codesign --force --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
echo "Local probe bundle: $PWD/$bundle"
