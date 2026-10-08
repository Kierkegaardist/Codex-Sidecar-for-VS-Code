# Packs the extension into codex-sidecar-vscode-<version>.vsix, the file VS Code installs. A .vsix is a zip
# of the files with two small ones that describe it, so this writes it directly: nothing to install
# first, no Node.
#   powershell -ExecutionPolicy Bypass -File pack.ps1            pack it
#   powershell -ExecutionPolicy Bypass -File pack.ps1 -Install   pack it and install it into VS Code
param([switch]$Install)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$package=Get-Content -LiteralPath (Join-Path $PSScriptRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$vsix=Join-Path $PSScriptRoot "$($package.name)-$($package.version).vsix"
Remove-Item -LiteralPath $vsix -ErrorAction SilentlyContinue
# (what goes in, and under which name)
$files=[ordered]@{
	"package.json"="package.json"; "extension.js"="extension.js"; "uninstall.js"="uninstall.js"; "README.md"="README.md"; "LICENSE"="LICENSE.txt"
	"media\pane.js"="media/pane.js"; "media\pane.css"="media/pane.css"; "launch\sidecar.ps1"="launch/sidecar.ps1"; "launch\sidecar.sh"="launch/sidecar.sh"
	"media\tab-dark.png"="media/tab-dark.png"; "media\tab-light.png"="media/tab-light.png"; "media\tab-failed.png"="media/tab-failed.png"
	"media\icon.png"="media/icon.png"; "media\logo-ink.png"="media/logo-ink.png"; "media\figure-a.png"="media/figure-a.png"; "media\figure-b.png"="media/figure-b.png"}
$xml={ param($text) [Security.SecurityElement]::Escape([string]$text) }
$described=[ordered]@{
	"[Content_Types].xml"='<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
		((".json","application/json"),(".js","application/javascript"),(".css","text/css"),(".png","image/png"),(".md","text/markdown"),(".txt","text/plain"),(".ps1","text/plain"),(".sh","text/plain"),(".vsixmanifest","text/xml") |
			ForEach-Object { '<Default Extension="'+$_[0]+'" ContentType="'+$_[1]+'"/>' })+'</Types>'
	"extension.vsixmanifest"='<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>'+
		'<Identity Language="en-US" Id="'+(& $xml $package.name)+'" Version="'+(& $xml $package.version)+'" Publisher="'+(& $xml $package.publisher)+'"/>'+
		'<DisplayName>'+(& $xml $package.displayName)+'</DisplayName><Description xml:space="preserve">'+(& $xml $package.description)+'</Description>'+
		'<Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="'+(& $xml $package.engines.vscode)+'"/>'+
		'<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties><License>extension/LICENSE.txt</License><Icon>extension/media/icon.png</Icon></Metadata>'+
		'<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets>'+
		'<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>'+
		'<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>'+
		'<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>'+
		'<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true"/></Assets></PackageManifest>'
}
$zip=[IO.Compression.ZipFile]::Open($vsix,"Create")
foreach ($name in $described.Keys) {
	$writer=New-Object IO.StreamWriter($zip.CreateEntry($name).Open())
	$writer.Write($described[$name])
	$writer.Dispose()
}
foreach ($from in $files.Keys) {
	[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $PSScriptRoot $from),"extension/$($files[$from])") | Out-Null
}
$zip.Dispose()
Write-Output "Packed $vsix"
if ($Install) { code --install-extension $vsix --force }
