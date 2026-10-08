<#
.SYNOPSIS
Runs one Codex task, and lets the Codex Sidecar pane in VS Code show it as it happens.

.DESCRIPTION
Claude Code (or you) calls this in place of a bare `codex exec`. It starts Codex on the task in
-Prompt, waits, and returns when Codex is done; the final answer is in -Out. While Codex works, his
event stream is written to ~/.codex-sidecar/runs, where the Codex Sidecar extension reads it and
shows it in a pane beside the chat. Without the extension this still works: nothing is shown.

    powershell -ExecutionPolicy Bypass -File sidecar.ps1 -Prompt task.md -Out answer.md

The person watching can step in: a message typed into the pane is left in <id>.say. This script then
ends what Codex is doing and continues the same Codex session with that message (`codex exec
resume`), as often as it happens. When it is all over it prints what was said, so that the agent
that called it knows.

.PARAMETER Prompt
A file holding the task. Codex cannot see Claude's conversation: the file has to say everything.
.PARAMETER Out
The file Codex's final answer is written to.
.PARAMETER Name
The name shown on the pane. "Codex" unless you call your helper something else.
.PARAMETER Title
A few words naming this conversation, shown on its tab. The task's first line when left out.
.PARAMETER Role
One line on what this helper is here to do, shown in the pane's overview. The start of the task
when left out.
.PARAMETER Model
The model to use. Codex's own default when left out.
.PARAMETER Effort
How hard the model should think: low, medium, high, or whatever your model accepts. Codex's own
default when left out. The pane shows the model and effort Codex really used, given here or not.
.PARAMETER Sandbox
read-only (the default), workspace-write or danger-full-access: what Codex's commands may touch.
.PARAMETER Dir
The folder Codex works in. The current folder when left out.
.PARAMETER Codex
The Codex program, if it is not on the PATH.
.PARAMETER CodexArgs
Anything else for `codex exec`, as one string, quoted as cmd.exe wants it.
Example: -CodexArgs '--skip-git-repo-check'
.PARAMETER Root
Where the run files go. ~/.codex-sidecar unless you are testing.
#>
param(
	[Parameter(Mandatory)][string]$Prompt,
	[Parameter(Mandatory)][string]$Out,
	[string]$Name="Codex",
	[string]$Title="",
	[string]$Role="",
	[string]$Model="",
	[string]$Effort="",
	[ValidateSet("read-only","workspace-write","danger-full-access")][string]$Sandbox="read-only",
	[string]$Dir="",
	[string]$Codex="",
	[string]$CodexArgs="",
	[string]$Root=""
)
try { [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false) } catch { }     # (what the person typed may not be plain ASCII)
$here=(Get-Location).Path
if (-not (Test-Path -LiteralPath $Prompt)) { Write-Output "There is no task file at $Prompt"; exit 2 }
$Prompt=(Resolve-Path -LiteralPath $Prompt).Path
$Out=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
if ($Out -eq $Prompt) { Write-Output "-Out is the task file itself. Give the answer a file of its own."; exit 2 }
if (-not $Dir) { $Dir=$here }
if (-not (Test-Path -LiteralPath $Dir)) { Write-Output "There is no folder at $Dir"; exit 2 }
$Dir=(Resolve-Path -LiteralPath $Dir).Path
if (-not $Codex) {
	# (an .exe or .cmd only: PowerShell would otherwise pick npm's codex.ps1, which cmd.exe cannot run)
	$found=Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\.(exe|cmd|bat)$' } | Select-Object -First 1
	if ($found) { $Codex=$found.Source } else { $Codex=Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe" }
}
if (-not (Test-Path -LiteralPath $Codex)) { Write-Output "Codex was not found. Install the Codex CLI and sign in, or pass -Codex <path to codex>."; exit 2 }
if (-not $Root) { $Root=Join-Path $HOME ".codex-sidecar" }
$runs=Join-Path $Root "runs"
New-Item $runs -ItemType Directory -Force | Out-Null
$id="{0}-{1:x4}" -f (Get-Date -Format "yyyyMMdd-HHmmss"),(Get-Random -Maximum 65536)
$base=Join-Path $runs $id
Remove-Item -LiteralPath $Out -ErrorAction SilentlyContinue

# Codex runs under cmd.exe, which does the redirecting: the task in, the events and the errors out.
# The paths reach cmd.exe as environment variables, so that a %NAME% inside a path is not read as one of its own.
$workIn=$Dir
if ($workIn.EndsWith('\')) { $workIn+='.' }     # (a \ before the closing quote would swallow the quote)
$env:SIDECAR_CODEX=$Codex; $env:SIDECAR_DIR=$workIn; $env:SIDECAR_OUT=$Out
$env:SIDECAR_PROMPT=$Prompt; $env:SIDECAR_EVENTS="$base.events.jsonl"; $env:SIDECAR_ERR="$base.err"
$line='"%SIDECAR_CODEX%" exec --json -s '+$Sandbox+' -C "%SIDECAR_DIR%" -o "%SIDECAR_OUT%"'
if ($Model) { $line+=" -m `"$Model`"" }
if ($Effort) { $line+=" -c model_reasoning_effort=$Effort" }
if ($CodexArgs) { $line+=" $CodexArgs" }
$line+=' - < "%SIDECAR_PROMPT%" > "%SIDECAR_EVENTS%" 2> "%SIDECAR_ERR%"'
$process=Start-Process -FilePath $env:ComSpec -ArgumentList "/d /v:off /s /c `"$line`"" -WindowStyle Hidden -PassThru
if (-not $process) { Write-Output "Codex could not be started."; exit 2 }
$null=$process.Handle     # (without this, PowerShell forgets the exit code)

# What the pane needs to know. The process it watches is this script, which lasts as long as the run does.
$meta=[ordered]@{
	sidecar=1; id=$id; name=$Name; title=$Title; role=$Role; model=$Model; effort=$Effort; sandbox=$Sandbox; cwd=$here; dir=$Dir; out=$Out
	pid=$PID; started=(Get-Date).ToUniversalTime().ToString("o"); prompt=[IO.File]::ReadAllText($Prompt)
}
[IO.File]::WriteAllText("$base.run.json",($meta | ConvertTo-Json -Compress))

$plain=New-Object Text.UTF8Encoding($false)
$said=@()          # what the person watching typed into the pane, in order
$taken=0           # lines of <id>.say already acted on
function Waiting {     # the messages nobody has acted on yet
	if (-not (Test-Path -LiteralPath "$base.say")) { return @() }
	$lines=@(Get-Content -LiteralPath "$base.say" -Encoding UTF8 | Where-Object { $_.Trim() })
	if ($lines.Count -le $taken) { return @() }
	return @($lines[$taken..($lines.Count-1)])
}
function Thread {      # Codex names its session in the first line it writes
	if (-not (Test-Path -LiteralPath "$base.events.jsonl")) { return "" }
	$first=Get-Content -LiteralPath "$base.events.jsonl" -TotalCount 3 -Encoding UTF8 | Where-Object { $_ -match '"thread_id"\s*:\s*"([^"]+)"' } | Select-Object -First 1
	if ($first -and $first -match '"thread_id"\s*:\s*"([^"]+)"') { return $Matches[1] }
	return ""
}
$stopped=$false
while ($true) {
	$cut=$false
	while (-not $process.HasExited) {
		if (Test-Path -LiteralPath "$base.stop") { $stopped=$true }     # (Stop was pressed in the pane)
		elseif ((Waiting).Count -and (Thread)) { $cut=$true }          # (a message was typed there)
		if ($stopped -or $cut) {
			& $env:ComSpec /d /c "taskkill /PID $($process.Id) /T /F >nul 2>&1"
			break
		}
		Start-Sleep -Milliseconds 400
	}
	$process.WaitForExit()
	if ($stopped) { break }
	$new=@(Waiting)
	$thread=Thread
	if (-not $new.Count -or -not $thread) { break }     # Codex is done, and nobody has more to say
	# Codex carries on in the same session with what was said. It is told when it was cut off, so that
	# it does not trust a step that never finished.
	$taken+=$new.Count
	$texts=@($new | ForEach-Object { try { ($_ | ConvertFrom-Json).text } catch { $_ } } | Where-Object { $_ })
	$said+=$texts
	foreach ($text in $texts) {     # (the pane shows the message where it fell in the work)
		# (on a line of its own, whatever half-written line the stopped Codex left behind)
		[IO.File]::AppendAllText("$base.events.jsonl",("`n"+(@{ type="sidecar.said"; text=[string]$text; cut=$cut } | ConvertTo-Json -Compress)+"`n"),$plain)
	}
	$note=if ($cut) { "The person watching you work has stepped in. You were stopped in the middle of a step, so whatever you were running did not finish: do not rely on it." } else { "The person watching you work has a message for you, now that you have answered." }
	[IO.File]::WriteAllText("$base.say.md","$note Their message:`n`n$($texts -join "`n`n")`n`nTake it into account and carry on with the task. End with your final answer, as before.",$plain)
	$env:SIDECAR_SAY="$base.say.md"; $env:SIDECAR_THREAD=$thread
	$line='"%SIDECAR_CODEX%" exec resume %SIDECAR_THREAD% --json -c sandbox_mode='+$Sandbox+' -o "%SIDECAR_OUT%"'
	if ($Model) { $line+=" -m `"$Model`"" }
	if ($Effort) { $line+=" -c model_reasoning_effort=$Effort" }
	if ($CodexArgs) { $line+=" $CodexArgs" }
	$line+=' - < "%SIDECAR_SAY%" >> "%SIDECAR_EVENTS%" 2>> "%SIDECAR_ERR%"'
	$process=Start-Process -FilePath $env:ComSpec -ArgumentList "/d /v:off /s /c `"$line`"" -WorkingDirectory $Dir -WindowStyle Hidden -PassThru
	if (-not $process) { break }
	$null=$process.Handle
}
$code=if ($stopped) { 130 } elseif ($process) { $process.ExitCode } else { 2 }
[IO.File]::WriteAllText("$base.exit",(@{ code=$code; stopped=$stopped } | ConvertTo-Json -Compress))

# The agent that called this was not there for what the person said: it is told now.
function Heard {
	if (-not $said.Count) { return }
	Write-Output "While $Name worked, the user stepped in from the pane and said to $Name`:"
	$n=0
	foreach ($text in $said) { $n++; Write-Output "  $n. $text" }
}
if ($stopped) { Write-Output "$Name was stopped from the pane before finishing. No answer."; Heard; exit 130 }
if ($code -ne 0 -and (Test-Path -LiteralPath "$base.err")) {
	$errors=(Get-Content -LiteralPath "$base.err" -Tail 12 -Encoding UTF8) -join "`n"
	if ($errors.Trim()) { Write-Output "Codex said:`n$errors" }
}
if (Test-Path -LiteralPath $Out) { Write-Output "$Name finished (exit $code). Answer: $Out ($((Get-Item -LiteralPath $Out).Length) bytes)" }
else { Write-Output "$Name finished (exit $code) but wrote no answer to $Out" }
Heard
if ($said.Count -and (Test-Path -LiteralPath $Out)) { Write-Output "The answer was written after that, with it taken into account." }
exit $code
