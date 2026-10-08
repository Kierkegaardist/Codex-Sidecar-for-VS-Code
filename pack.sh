#!/usr/bin/env bash
# Packs the extension into codex-sidecar-vscode-<version>.vsix on macOS and Linux, as pack.ps1 does on
# Windows. A .vsix is a zip of the files with two small ones that describe it, so this writes it
# directly: it needs `zip` and nothing else, no Node.
#   bash pack.sh             pack it
#   bash pack.sh --install   pack it and install it into VS Code
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
command -v zip >/dev/null || { echo "This needs the zip program. Install it (for example: sudo apt install zip) and run this again."; exit 2; }
field() { sed -n 's/^[[:space:]]*"'"$1"'":[[:space:]]*"\(.*\)",\{0,1\}[[:space:]]*$/\1/p' package.json | head -n 1; }
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
name=$(field name); version=$(field version); publisher=$(field publisher)
engine=$(sed -n 's/.*"vscode":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
vsix=$here/$name-$version.vsix
rm -f "$vsix"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/extension/media" "$tmp/extension/launch"
cp package.json extension.js uninstall.js README.md "$tmp/extension/"
cp LICENSE "$tmp/extension/LICENSE.txt"
cp media/pane.js media/pane.css media/*.png "$tmp/extension/media/"
cp launch/sidecar.ps1 launch/sidecar.sh "$tmp/extension/launch/"
cat > "$tmp/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".css" ContentType="text/css"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".ps1" ContentType="text/plain"/><Default Extension=".sh" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
EOF
cat > "$tmp/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="$(xml "$name")" Version="$(xml "$version")" Publisher="$(xml "$publisher")"/><DisplayName>$(xml "$(field displayName)")</DisplayName><Description xml:space="preserve">$(xml "$(field description)")</Description><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(xml "$engine")"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties><License>extension/LICENSE.txt</License><Icon>extension/media/icon.png</Icon></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true"/></Assets></PackageManifest>
EOF
( cd "$tmp" && zip -q -r "$vsix" '[Content_Types].xml' extension.vsixmanifest extension )
echo "Packed $vsix"
if [ "${1-}" = "--install" ]; then code --install-extension "$vsix" --force; fi
