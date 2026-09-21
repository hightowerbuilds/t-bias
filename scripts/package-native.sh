#!/usr/bin/env bash
# Local .app + ZIP. Developer ID / notarization are opt-in via environment.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-release}"
if [[ "$profile" != release && "$profile" != debug ]]; then echo 'Usage: package-native.sh [release|debug]' >&2; exit 2; fi
cd "$repo_dir/app"
if [[ "$profile" == release ]]; then cargo build --release --locked; else cargo build --locked; fi
output="$repo_dir/dist-native"
bundle="$output/t-bias.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "target/$profile/t-bias" "$bundle/Contents/MacOS/t-bias"
if [[ "$profile" == release ]]; then strip -x "$bundle/Contents/MacOS/t-bias"; fi
cp "$repo_dir/app/assets/AppIcon.icns" "$bundle/Contents/Resources/AppIcon.icns"
chmod 755 "$bundle/Contents/MacOS/t-bias"
chmod 644 "$bundle/Contents/Resources/AppIcon.icns"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>t-bias</string>
<key>CFBundleDisplayName</key><string>t-bias</string>
<key>CFBundleIdentifier</key><string>com.tbias.app</string>
<key>CFBundleExecutable</key><string>t-bias</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHumanReadableCopyright</key><string>t-bias</string>
</dict></plist>
PLIST
plutil -lint "$bundle/Contents/Info.plist"
if [[ -n "${TBIAS_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp --sign "$TBIAS_SIGN_IDENTITY" "$bundle"
else
  codesign --force --sign - "$bundle"
  echo 'Signed locally (ad hoc). Developer ID distribution is not enabled.'
fi
codesign --verify --deep --strict "$bundle"
archive="$output/t-bias-macos-$(uname -m).zip"
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
if [[ -n "${TBIAS_NOTARY_PROFILE:-}" ]]; then
  [[ -n "${TBIAS_SIGN_IDENTITY:-}" ]] || { echo 'Notarization requires TBIAS_SIGN_IDENTITY' >&2; exit 2; }
  xcrun notarytool submit "$archive" --keychain-profile "$TBIAS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$bundle"
  xcrun stapler validate "$bundle"
  ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
fi
echo "Bundle: $bundle"
echo "Archive: $archive"
