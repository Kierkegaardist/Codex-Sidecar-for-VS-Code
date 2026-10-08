#!/usr/bin/env bash
# A stand-in for Codex on macOS and Linux, for trying the pane and launch/sidecar.sh without spending
# a real run: it prints a recorded event stream, one line at a time. Give it to the launcher with
# --codex. FAKE_SCRIPT names another .jsonl to play; FAKE_DELAY is the pause between lines in seconds
# (1 if not set). Like Codex, it leaves a final answer in the file named after -o. Asked to carry a
# session on ("exec resume"), it plays sample-resume.jsonl, or the file FAKE_RESUME names.
here=$(cd "$(dirname "$0")" && pwd)
again=0; [ "${2-}" = "resume" ] && again=1
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out=${2-}; shift; done
if [ "$again" = 1 ]; then file=${FAKE_RESUME:-$here/sample-resume.jsonl}; else file=${FAKE_SCRIPT:-$here/sample-run.jsonl}; fi
while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; sleep "${FAKE_DELAY:-1}"; done < "$file"
[ -n "$out" ] && echo "The stand-in for Codex answers: lantern.txt says a lantern." > "$out"
exit 0
