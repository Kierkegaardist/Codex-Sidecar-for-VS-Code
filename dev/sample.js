// A made-up job in Codex's real event format, for dev/preview.html. One finished run and one still going.
window.SAMPLE = [
	{
		run: { id: 'a', name: 'Codex', model: 'gpt-5.5', effort: 'high', sandbox: 'read-only', dir: 'C:\\work\\lantern', started: Date.now() - 96000, live: true,
			prompt: 'Review src/timer.js before I merge it.\n\nThe countdown sometimes ends a second early. Read the file and its test, run the tests, and tell me:\n1. what causes it,\n2. the smallest fix,\n3. anything else in that file you would not ship.\n\nRead-only: do not change anything.' },
		events: [
			{ type: 'thread.started', thread_id: '0' },
			{ type: 'turn.started' },
			{ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I\u2019ll read the timer and its test first, then run the suite to see the failure for myself.' } },
			{ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: '**Reading the countdown**\n\nThe remaining time is worked out from `Date.now()` on every tick, then floored. A tick that lands a few milliseconds late would drop a whole second.' } },
			{ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-Content -LiteralPath src/timer.js\'', aggregated_output: 'export function remaining(endsAt, now = Date.now()) {\n  const ms = endsAt - now;\n  return Math.floor(ms / 1000);\n}\n\nexport function start(seconds, onTick, onDone) {\n  const endsAt = Date.now() + seconds * 1000;\n  const id = setInterval(() => {\n    const left = remaining(endsAt);\n    onTick(left);\n    if (left <= 0) {\n      clearInterval(id);\n      onDone();\n    }\n  }, 1000);\n  return () => clearInterval(id);\n}\n', exit_code: 0, status: 'completed' } },
			{ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'npm test --silent\'', aggregated_output: ' FAIL  test/timer.test.js\n  x counts down from three (1004 ms)\n\n    expected: [2, 1, 0]\n    received: [1, 0]\n\nTests: 1 failed, 4 passed, 5 total\n', exit_code: 1, status: 'failed' } },
			{ type: 'item.completed', item: { id: 'i4', type: 'todo_list', items: [{ text: 'Find why a second goes missing', completed: true }, { text: 'Check the test is fair', completed: true }, { text: 'Look over the rest of the file', completed: false }] } },
			{ type: 'item.completed', item: { id: 'i5', type: 'web_search', query: 'setInterval drift late callbacks' } },
			{ type: 'item.completed', item: { id: 'i6', type: 'agent_message', text: '### What causes it\n\n`remaining` floors the time left. The first tick fires a few milliseconds **after** one second, so 1.996 s is shown as `1`, not `2`.\n\n### The smallest fix\n\n```js\nreturn Math.max(0, Math.ceil(ms / 1000));\n```\n\n### What else I would not ship\n\n- `start` never calls `onTick` for the opening number, so the display is blank for a second.\n- A negative `seconds` runs forever in the other direction; clamp it.\n\nThe test is fair. With the one-line change, all five pass.' } },
			{ type: 'turn.completed', usage: { input_tokens: 48210, cached_input_tokens: 39424, output_tokens: 612 } }
		],
		end: { code: 0, at: Date.now() - 55000 }
	},
	{
		run: { id: 'b', name: 'Codex', model: 'gpt-5.5', effort: 'high', sandbox: 'workspace-write', dir: 'C:\\work\\lantern', started: Date.now() - 21000, live: true,
			prompt: 'Good. Make that one-line fix and add the opening tick.' },
		events: [
			{ type: 'item.completed', item: { id: 'j0', type: 'agent_message', text: 'Making both changes now, then running the tests again.' } },
			{ type: 'future.notice', message: 'An event of a kind this page has not seen before is shown as it came.' },
			{ type: 'item.completed', item: { id: 'j1', type: 'file_change', changes: [{ path: 'C:\\work\\lantern\\src\\timer.js', kind: 'update' }], status: 'completed' } },
			{ type: 'item.completed', item: { id: 'j2', type: 'file_change', changes: [{ path: 'C:\\work\\lantern\\test\\timer.test.js', kind: 'update' }, { path: 'C:\\work\\lantern\\test\\opening-tick.test.js', kind: 'add' }, { path: 'C:\\work\\lantern\\notes.tmp', kind: 'delete' }], status: 'completed' } },
			{ type: 'item.completed', item: { id: 'j3', type: 'command_execution', command: 'bash -lc \'npm test --silent\'', aggregated_output: 'Tests: 6 passed, 6 total\n', exit_code: 0, status: 'completed' } },
			{ type: 'item.completed', item: { id: 'j4', type: 'agent_message', text: 'Both changes are in, with a test for the opening tick. All six tests pass.' } },
			{ type: 'turn.completed', usage: { input_tokens: 30110, cached_input_tokens: 25600, output_tokens: 380 } }
		],
		end: { code: 0, at: Date.now() - 9000 }
	},
	{
		run: { id: 'c', name: 'Codex', model: 'gpt-5.5', effort: 'high', sandbox: 'read-only', dir: 'C:\\work\\lantern', started: Date.now() - 6000, live: true,
			prompt: 'One more look: is anything else in src/ built on the old floor?' },
		events: [
			{ type: 'item.started', item: { id: 'k0', type: 'command_execution', command: 'bash -lc \'rg -n "Math.floor" src\'', aggregated_output: '', exit_code: null, status: 'in_progress' } }
		]
	}
];
