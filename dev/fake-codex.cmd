@rem A stand-in for Codex, for trying the pane without spending a real run: it prints a recorded event
@rem stream, one line at a time. Give it to the launcher with -Codex. FAKE_SCRIPT names another .jsonl
@rem to play; FAKE_DELAY is the pause between lines in milliseconds (1000 if not set). Like Codex, it
@rem leaves a final answer in the file the launcher named. Asked to carry a session on ("exec resume",
@rem which is what the launcher does when someone steps in from the pane), it plays sample-resume.jsonl,
@rem or the file FAKE_RESUME names.
@powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $again = '%2' -eq 'resume'; $f = $(if ($again) { $env:FAKE_RESUME } else { $env:FAKE_SCRIPT }); if (-not $f) { $f = '%~dp0' + $(if ($again) { 'sample-resume.jsonl' } else { 'sample-run.jsonl' }) }; $d = [int]$env:FAKE_DELAY; if (-not $d) { $d = 1000 }; Get-Content -LiteralPath $f -Encoding UTF8 | ForEach-Object { [Console]::Out.WriteLine($_); [Console]::Out.Flush(); Start-Sleep -Milliseconds $d }; if ($env:SIDECAR_OUT) { Set-Content -LiteralPath $env:SIDECAR_OUT -Value $(if ($again) { 'The stand-in for Codex answers, after being told something: lantern.txt says a lantern.' } else { 'The stand-in for Codex answers: lantern.txt says a lantern.' }) -Encoding UTF8 }"
