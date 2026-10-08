# A second VS Code for trying the extension, apart from your own: its own settings folder, its own
# extensions folder (both under %TEMP%\codex-sidecar-test), and a debugging port through which a
# script can question its page, click in it and picture it. Each start packs the extension afresh.
#
#   -Action start     pack the extension, install it there, and open the test window on a sample folder
#   -Action stop      close it
#   -Action eval      run -Js in the VS Code window itself and print what it returns
#   -Action weval     run -Js inside each open pane; it is a function body, given `doc`, the pane's document
#   -Action shot      save a picture of the window to -Out
#
# -Extra adds settings for the test window, written with single quotes:
#   -Action start -Extra ", 'codexSidecar.closeAfterMinutes': 0"
# -Also installs one more .vsix beside the extension.
#
# The test window is given a pretend home folder (%TEMP%\codex-sidecar-test\home), so what the
# extension keeps outside itself (the launcher, the runs, the skill in Claude Code's folder) lands
# there and your own are left alone. A run shows in the test window when the launcher is started from
# its sample folder and pointed at that home:
#   cd $env:TEMP\codex-sidecar-test\workspace
#   powershell -ExecutionPolicy Bypass -File <repo>\launch\sidecar.ps1 -Codex <repo>\dev\fake-codex.cmd -Prompt task.md -Out answer.md -Root $env:TEMP\codex-sidecar-test\home\.codex-sidecar
param([Parameter(Mandatory)][string]$Action, [string]$Js="", [string]$Out="", [int]$Port=9333, [string]$Extra="", [string]$Also="")
$root=Join-Path $env:TEMP "codex-sidecar-test"
$data=Join-Path $root "data"; $exts=Join-Path $root "extensions"; $ws=Join-Path $root "workspace"
$repo=Split-Path $PSScriptRoot -Parent
$install=Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code"

function Targets { try { $list=Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2; foreach ($one in $list) { $one } } catch { } }
function Cdp($wsUrl,$method,$params) {
	if (-not $wsUrl) { throw "the test window is not there" }
	$ErrorActionPreference='Stop'
	$socket=New-Object System.Net.WebSockets.ClientWebSocket
	$none=[Threading.CancellationToken]::None
	$socket.ConnectAsync([Uri]$wsUrl,$none).Wait()
	$bytes=[Text.Encoding]::UTF8.GetBytes((@{ id=1; method=$method; params=$params } | ConvertTo-Json -Depth 8 -Compress))
	$socket.SendAsync((New-Object 'ArraySegment[byte]' (,$bytes)),'Text',$true,$none).Wait()
	$buffer=New-Object byte[] 4194304; $text=New-Object Text.StringBuilder
	while ($true) {
		$got=$socket.ReceiveAsync((New-Object 'ArraySegment[byte]' (,$buffer)),$none); $got.Wait()
		[void]$text.Append([Text.Encoding]::UTF8.GetString($buffer,0,$got.Result.Count))
		if ($got.Result.EndOfMessage) {
			$whole=$text.ToString(); [void]$text.Clear()
			if ($whole -match '^\{"id":1[,}]') { $socket.Dispose(); return $whole }     # (anything else is an event we did not ask for)
		}
	}
}
function Evaluate($target,$expression) {
	$raw=Cdp $target.webSocketDebuggerUrl "Runtime.evaluate" @{ expression=$expression; returnByValue=$true; awaitPromise=$true }
	$answer=($raw | ConvertFrom-Json).result
	if ($answer.exceptionDetails) { "ERROR: $($answer.exceptionDetails.exception.description)" } else { $answer.result.value }
}
function Window { Targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*workbench*' } | Select-Object -First 1 }
function Processes { Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like "*codex-sidecar-test*" } }

switch ($Action) {
	'start' {
		Processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
		Start-Sleep -Milliseconds 800
		New-Item (Join-Path $data "User"),$ws,(Join-Path $root "home\.claude") -ItemType Directory -Force | Out-Null
		$env:USERPROFILE=Join-Path $root "home"
		if (-not (Test-Path (Join-Path $ws "lantern.txt"))) { "a lantern" | Set-Content (Join-Path $ws "lantern.txt") -Encoding Ascii }
		if (-not (Test-Path (Join-Path $ws "task.md"))) { "A task for the stand-in." | Set-Content (Join-Path $ws "task.md") -Encoding Ascii }
		'{ "workbench.startupEditor": "none", "security.workspace.trust.enabled": false, "window.restoreWindows": "none", "update.mode": "none", "telemetry.telemetryLevel": "off", "extensions.autoUpdate": false, "workbench.colorTheme": "Default Dark Modern", "window.newWindowDimensions": "maximized" EXTRA }'.Replace('EXTRA',$Extra.Replace([char]39,[char]34)) |
			Set-Content (Join-Path $data "User\settings.json") -Encoding Ascii
		powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "pack.ps1") | Out-Null
		$vsix=Get-ChildItem $repo -Filter "*.vsix" | Select-Object -First 1
		foreach ($one in @($vsix.FullName,$Also) | Where-Object { $_ }) {
			& (Join-Path $install "bin\code.cmd") --user-data-dir $data --extensions-dir $exts --install-extension $one --force 2>$null | Out-Null
		}
		# (a shell started from inside VS Code carries its settings; with them a new VS Code starts as a bare
		#  script runner and exits at once)
		Get-ChildItem Env: | Where-Object { $_.Name -match '^(ELECTRON|VSCODE)' } | ForEach-Object { Remove-Item "Env:\$($_.Name)" -ErrorAction SilentlyContinue }
		Start-Process (Join-Path $install "Code.exe") -ArgumentList "--user-data-dir `"$data`" --extensions-dir `"$exts`" --remote-debugging-port=$Port --remote-allow-origins=* --new-window --disable-workspace-trust `"$ws`" `"$ws\lantern.txt`""
		for ($i=0; $i -lt 30 -and -not (Window); $i++) { Start-Sleep -Milliseconds 700 }
		Start-Sleep -Seconds 4
		if (-not (Window)) { "the test window did not come up"; break }
		# (a first start shows VS Code's own welcome over everything: click it away)
		foreach ($try in 1..3) {
			$said=Evaluate (Window) "(() => { const hit = [...document.querySelectorAll('a, button, .monaco-button')].find(e => /Continue without Signing In|^Get Started$/i.test(e.textContent.trim())); if (hit) { hit.click(); return 'closed'; } return ''; })()"
			if (-not $said) { break }
			Start-Sleep -Seconds 1
		}
		"test window: $((Window).title)"
	}
	'stop' { Processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "stopped" }
	'eval' { Evaluate (Window) $Js }
	'weval' {
		# (a pane is an iframe holding an inner frame with the page; `doc` is that inner document)
		foreach ($target in (Targets | Where-Object { $_.type -eq 'iframe' -and $_.url -like 'vscode-webview://*' })) {
			Evaluate $target "(() => { const frame = document.querySelector('#active-frame'); const doc = frame && frame.contentDocument; if (!doc || !doc.querySelector('.feed')) return 'not a pane'; $Js })()"
		}
	}
	'shot' {
		$raw=Cdp (Window).webSocketDebuggerUrl "Page.captureScreenshot" @{ format='png' }
		if ($raw -match '"data":"([^"]+)"') { [IO.File]::WriteAllBytes($Out,[Convert]::FromBase64String($Matches[1])); "saved $Out" } else { "no picture" }
	}
}
