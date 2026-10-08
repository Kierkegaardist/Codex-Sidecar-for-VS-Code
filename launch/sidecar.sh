#!/usr/bin/env bash
# Runs one Codex task, and lets the Codex Sidecar pane in VS Code show it as it happens.
# The launcher for macOS and Linux: it does what launch/sidecar.ps1 does on Windows, line for line.
# It is checked on a real Mac and on Linux (bash 3.2 and 5, the awk of each), with a stand-in for Codex.
#
#   bash sidecar.sh --prompt task.md --out answer.md
#
# Your agent (or you) calls this in place of a bare `codex exec`. It starts Codex on the task in
# --prompt, waits, and returns when Codex is done; the final answer is in --out. While Codex works,
# its event stream is written to ~/.codex-sidecar/runs, where the extension reads it and shows it in
# a pane beside the chat. Without the extension this still works: nothing is shown.
#
# The person watching can step in: a message typed into the pane is left in <id>.say. This script
# then ends what Codex is doing and continues the same Codex session with that message (`codex exec
# resume`), as often as it happens. When it is all over it prints what was said, so that the agent
# that called it knows.
#
#   --prompt <file>     the task. Codex cannot see the agent's conversation: the file says everything
#   --out <file>        where Codex's final answer is written
#   --name <name>       the name shown on the pane ("Codex" when left out)
#   --title "<words>"   names the conversation on its tab (the task's first line when left out)
#   --role "<line>"     what this helper is here to do, shown in the overview
#   --model <name>      the model (Codex's own default when left out)
#   --effort <level>    low, medium, high, or whatever your model accepts
#   --sandbox <mode>    read-only (the default), workspace-write or danger-full-access
#   --dir <folder>      the folder Codex works in (the current folder when left out)
#   --codex <path>      the Codex program, if it is not on the PATH
#   --codex-args "<…>"  anything else for `codex exec`, for example "--skip-git-repo-check"
#   --root <folder>     where the run files go (~/.codex-sidecar unless you are testing)
set -u
prompt=""; out=""; name="Codex"; title=""; role=""; model=""; effort=""; sandbox="read-only"; dir=""; codex=""; codex_args=""; root=""
while [ $# -gt 0 ]; do
	case "$1" in
		--prompt) prompt=${2-}; shift 2 ;;
		--out) out=${2-}; shift 2 ;;
		--name) name=${2-}; shift 2 ;;
		--title) title=${2-}; shift 2 ;;
		--role) role=${2-}; shift 2 ;;
		--model) model=${2-}; shift 2 ;;
		--effort) effort=${2-}; shift 2 ;;
		--sandbox) sandbox=${2-}; shift 2 ;;
		--dir) dir=${2-}; shift 2 ;;
		--codex) codex=${2-}; shift 2 ;;
		--codex-args) codex_args=${2-}; shift 2 ;;
		--root) root=${2-}; shift 2 ;;
		*) echo "Unknown option: $1"; exit 2 ;;
	esac
done
if [ -z "$prompt" ] || [ -z "$out" ]; then echo "Usage: bash sidecar.sh --prompt <task file> --out <answer file>"; exit 2; fi
case "$sandbox" in read-only|workspace-write|danger-full-access) ;; *) echo "--sandbox is read-only, workspace-write or danger-full-access"; exit 2 ;; esac
here=$PWD
whole() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
if [ ! -f "$prompt" ]; then echo "There is no task file at $prompt"; exit 2; fi
prompt=$(whole "$prompt"); out=$(whole "$out")
if [ "$out" = "$prompt" ]; then echo "--out is the task file itself. Give the answer a file of its own."; exit 2; fi
[ -n "$dir" ] || dir=$here
if [ ! -d "$dir" ]; then echo "There is no folder at $dir"; exit 2; fi
dir=$(cd "$dir" && pwd)
[ -n "$codex" ] || codex=$(command -v codex 2>/dev/null || true)
if [ -z "$codex" ] || [ ! -x "$codex" ]; then echo "Codex was not found. Install the Codex CLI and sign in, or pass --codex <path to codex>."; exit 2; fi
[ -n "$root" ] || root=$HOME/.codex-sidecar
runs=$root/runs
mkdir -p "$runs"
id=$(date +%Y%m%d-%H%M%S)-$(printf '%04x' $((RANDOM * 2 % 65536)))
base=$runs/$id
rm -f "$out"

# A piece of text as a JSON string. (No jq, node or python is asked for: awk is everywhere.)
# (sed does the escaping, since the awks disagree on a backslash in a replacement; LC_ALL=C because the
#  macOS tools refuse bytes that are not good UTF-8)
tab=$'\t'; cr=$'\r'
json() {
	LC_ALL=C tr -d '\000-\010\013\014\016-\037' | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$tab/\\\\t/g" -e "s/$cr/\\\\r/g" |
		LC_ALL=C awk 'BEGIN { ORS = ""; printf "%s", "\"" } { if (NR > 1) printf "%s", "\\n"; print } END { printf "%s", "\"" }'
}
# The text of one line of <id>.say, which the extension writes as {"at":"…","text":"…"}.
said_text() {
	LC_ALL=C sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\(.*\)"[[:space:]]*}[[:space:]]*$/\1/p' | LC_ALL=C awk '{
		out = ""; n = length($0)
		for (i = 1; i <= n; i++) {
			c = substr($0, i, 1)
			if (c != "\\" || i == n) { out = out c; continue }
			d = substr($0, ++i, 1)
			if (d == "n") out = out "\n"; else if (d == "t") out = out "\t"; else if (d == "r") out = out "\r"
			else if (d == "\"" || d == "\\" || d == "/") out = out d; else out = out "\\" d
		}
		print out }'
}

# Codex, on the task, with the events and the errors written where the pane reads them.
child=0
begin() {   # $1 is "resume" when a session is carried on
	if [ "${1-}" = "resume" ]; then
		# shellcheck disable=SC2086
		( cd "$dir" && exec "$codex" exec resume "$thread" --json -c "sandbox_mode=$sandbox" -o "$out" ${model:+-m "$model"} ${effort:+-c "model_reasoning_effort=$effort"} $codex_args - < "$base.say.md" >> "$base.events.jsonl" 2>> "$base.err" ) &
	else
		# shellcheck disable=SC2086
		( exec "$codex" exec --json -s "$sandbox" -C "$dir" -o "$out" ${model:+-m "$model"} ${effort:+-c "model_reasoning_effort=$effort"} $codex_args - < "$prompt" > "$base.events.jsonl" 2> "$base.err" ) &
	fi
	child=$!
}
begin

# What the pane needs to know. The process it watches is this script, which lasts as long as the run does.
{
	printf '{"sidecar":1,"id":%s,"name":%s,"title":%s,"role":%s,"model":%s,"effort":%s,"sandbox":%s,"cwd":%s,"dir":%s,"out":%s,"pid":%d,"started":%s,"prompt":' \
		"$(printf '%s' "$id" | json)" "$(printf '%s' "$name" | json)" "$(printf '%s' "$title" | json)" "$(printf '%s' "$role" | json)" "$(printf '%s' "$model" | json)" \
		"$(printf '%s' "$effort" | json)" "$(printf '%s' "$sandbox" | json)" "$(printf '%s' "$here" | json)" "$(printf '%s' "$dir" | json)" "$(printf '%s' "$out" | json)" \
		"$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ | json)"
	json < "$prompt"
	printf '}'
} > "$base.run.json.part"
mv "$base.run.json.part" "$base.run.json"

said=()        # what the person watching typed into the pane, in order
taken=0        # lines of <id>.say already acted on
stopped=0
code=0
thread=""
waiting() {    # the messages nobody has acted on yet
	[ -f "$base.say" ] || return 0
	awk 'NF' "$base.say" | tail -n +$((taken + 1))
}
session() {    # Codex names its session in the first line it writes
	[ -f "$base.events.jsonl" ] || return 0
	head -n 3 "$base.events.jsonl" | sed -n 's/.*"thread_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}
while :; do
	cut=0
	while kill -0 "$child" 2>/dev/null; do
		if [ -f "$base.stop" ]; then stopped=1                               # (Stop was pressed in the pane)
		elif [ -n "$(waiting)" ] && [ -n "$(session)" ]; then cut=1; fi      # (a message was typed there)
		if [ "$stopped" = 1 ] || [ "$cut" = 1 ]; then
			pkill -TERM -P "$child" 2>/dev/null   # (whatever Codex was running)
			kill "$child" 2>/dev/null
			break
		fi
		sleep 0.4
	done
	wait "$child" 2>/dev/null
	code=$?
	[ "$stopped" = 1 ] && break
	new=$(waiting)
	thread=$(session)
	if [ -z "$new" ] || [ -z "$thread" ]; then break; fi     # Codex is done, and nobody has more to say
	# Codex carries on in the same session with what was said. It is told when it was cut off, so that
	# it does not trust a step that never finished.
	message=""
	while IFS= read -r line; do
		taken=$((taken + 1))
		text=$(printf '%s\n' "$line" | said_text)
		[ -n "$text" ] || text=$line
		said+=("$text")
		# (the pane shows the message where it fell in the work, on a line of its own)
		printf '\n{"type":"sidecar.said","text":%s,"cut":%s}\n' "$(printf '%s' "$text" | json)" "$([ "$cut" = 1 ] && echo true || echo false)" >> "$base.events.jsonl"
		message="$message$text"$'\n\n'
	done <<EOF
$new
EOF
	if [ "$cut" = 1 ]; then note="The person watching you work has stepped in. You were stopped in the middle of a step, so whatever you were running did not finish: do not rely on it."
	else note="The person watching you work has a message for you, now that you have answered."; fi
	printf '%s Their message:\n\n%sTake it into account and carry on with the task. End with your final answer, as before.' "$note" "$message" > "$base.say.md"
	begin resume
done
[ "$stopped" = 1 ] && code=130
printf '{"code":%d,"stopped":%s}' "$code" "$([ "$stopped" = 1 ] && echo true || echo false)" > "$base.exit"

# The agent that called this was not there for what the person said: it is told now.
heard() {
	[ "${#said[@]}" -gt 0 ] || return 0
	echo "While $name worked, the user stepped in from the pane and said to $name:"
	n=0
	for text in "${said[@]}"; do n=$((n + 1)); echo "  $n. $text"; done
}
if [ "$stopped" = 1 ]; then echo "$name was stopped from the pane before finishing. No answer."; heard; exit 130; fi
if [ "$code" -ne 0 ] && [ -s "$base.err" ]; then echo "Codex said:"; tail -n 12 "$base.err"; fi
if [ -f "$out" ]; then echo "$name finished (exit $code). Answer: $out ($(wc -c < "$out" | tr -d ' ') bytes)"
else echo "$name finished (exit $code) but wrote no answer to $out"; fi
heard
if [ "${#said[@]}" -gt 0 ] && [ -f "$out" ]; then echo "The answer was written after that, with it taken into account."; fi
exit "$code"
