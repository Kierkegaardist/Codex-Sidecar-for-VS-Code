// Codex Sidecar: the VS Code side.
//
// The launcher (launch/sidecar.ps1, run by the agent) starts Codex and writes three files for each
// run into ~/.codex-sidecar/runs:
//   <id>.run.json       what was asked, and of whom
//   <id>.events.jsonl   Codex's event stream, as it is written
//   <id>.exit           how it ended
// This extension watches that folder and shows the runs that belong to this window's workspace in
// tabs beside the editor. It starts nothing and stops nothing: it reads those files, and it leaves
// two kinds of note for the launcher to act on: <id>.stop when Stop is pressed, and a line in
// <id>.say when the person watching types a message for Codex.
//
// A run is a conversation, and each has a tab of its own, named after it. A new one opens in front
// of the others, in the same place, however many are going at once. A finished tab closes itself
// after a countdown unless it is told to stay.
'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const HOME = path.join(os.homedir(), '.codex-sidecar');
const RUNS = path.join(HOME, 'runs');
// The launcher is a PowerShell script on Windows and a shell script on macOS and Linux, written to
// do the same.
const WINDOWS = process.platform === 'win32';
const LAUNCHER = WINDOWS ? 'sidecar.ps1' : 'sidecar.sh';
// Where agents look for skills, whatever the project, each with the folder that has to be there
// already: an agent's own folder is a sign that the agent is installed, and we do not make one.
// ~/.agents is the one they share, so that one we do make.
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ANTIGRAVITY = path.join(os.homedir(), '.gemini');
const SKILLS = [
	[path.join(CLAUDE, 'skills'), CLAUDE],                                               // Claude Code (Copilot and Cursor read it too)
	[path.join(os.homedir(), '.agents', 'skills'), os.homedir()],                        // Copilot in VS Code, Cursor, Codex
	[path.join(ANTIGRAVITY, 'config', 'skills'), ANTIGRAVITY],                                     // Antigravity
	[path.join(ANTIGRAVITY, 'antigravity-cli', 'skills'), path.join(ANTIGRAVITY, 'antigravity-cli')]   // Antigravity's CLI
].map(([skills, needs]) => ({ folder: path.join(skills, 'codex-sidecar'), needs }));
const WEEK = 7 * 24 * 3600 * 1000;
const file = (id, kind) => path.join(RUNS, id + '.' + kind);
const readJson = name => JSON.parse(fs.readFileSync(name, 'utf8').replace(/^﻿/, ''));
const config = () => vscode.workspace.getConfiguration('codexSidecar');
const nameOf = meta => meta.name || 'Codex';
// The helper as it is shown: its name with the number of the model behind it ("Sol 6.1" for a helper
// called Sol on gpt-6.1-sol), once the model is known: from the launcher, or from Codex's own record.
const numberIn = model => (String(model || '').match(/\d+(?:\.\d+)+|\d+/) || [''])[0];
const labelOf = (meta, using) => {
	const name = nameOf(meta);
	const number = numberIn((using && using.model) || meta.model);
	return number && !name.includes(number) ? name + ' ' + number : name;
};
const startedAt = run => Date.parse(run.meta.started) || Date.now();
// What a conversation is called, and what its helper is there for: as the agent put it, or else
// taken from the task itself.
const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim();
const shorten = (text, most) => (text.length > most ? text.slice(0, most - 1).trimEnd() + '…' : text);
const titleOf = meta => shorten(oneLine(meta.title) || oneLine((String(meta.prompt || '').split('\n').find(line => line.trim()) || '').replace(/^[\s#>*-]+/, '')) || 'Task', 48);
const roleOf = meta => shorten(oneLine(meta.role) || oneLine(meta.prompt), 200);

let extensionUri;
let statusItem;                 // the marker in the status bar
let statusHide = null;
let placing = Promise.resolve();   // runs are given their tabs one at a time: opening one is not instant
const panes = [];               // the open tabs, oldest first: { panel, ready, id, meta, run, state, kept, closing, closesAt }
const following = new Map();    // runs still going: id -> what has been read of them so far
const announced = new Set();    // runs this window has already looked at
const told = new Map();         // runs that are over: id -> their line in the overview, worked out once

function activate(context) {
	extensionUri = context.extensionUri;
	fs.mkdirSync(RUNS, { recursive: true });
	// the launcher is kept at a path that does not change from one version to the next
	try {
		fs.copyFileSync(path.join(context.extensionPath, 'launch', LAUNCHER), path.join(HOME, LAUNCHER));
		if (!WINDOWS) fs.chmodSync(path.join(HOME, LAUNCHER), 0o755);
	} catch (e) { /* another window is writing it */ }
	sweep();
	const sweeping = setInterval(sweep, 6 * 3600 * 1000);   // (a window can stay open for days)
	const watcher = fs.watch(RUNS, (_event, name) => {
		// (the launcher writes the record under a ".part" name and renames it, and macOS may report the
		//  rename under the old name only)
		const id = name && (name.match(/^(.+)\.run\.json(\.part)?$/) || [])[1];
		if (id) announce(id, 0, false);
	});
	watcher.on('error', () => { });   // (the folder was deleted under us: there is nothing left to watch)
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusItem.command = 'codexSidecar.show';
	statusItem.tooltip = 'Codex Sidecar: show the latest run';
	context.subscriptions.push(
		statusItem,
		{ dispose: () => { watcher.close(); clearInterval(sweeping); following.forEach(run => clearInterval(run.timer)); panes.forEach(pane => clearTimeout(pane.closing)); clearTimeout(statusHide); } },
		vscode.commands.registerCommand('codexSidecar.show', showLatest),
		vscode.commands.registerCommand('codexSidecar.copySetup', copySetup),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('codexSidecar')) { panes.forEach(sendPrefs); tellAgents(); } })
	);
	// runs of this workspace that are still going: the window was reloaded, or opened late
	for (const id of runIds()) if (!fs.existsSync(file(id, 'exit'))) announce(id, 0, true);
	const agentsKnow = tellAgents();
	if (!context.globalState.get('welcomed')) {
		context.globalState.update('welcomed', true);
		if (agentsKnow) vscode.window.showInformationMessage('Codex Sidecar is installed, and there is nothing to set up. Ask your agent (Claude Code, Copilot, Cursor) to hand Codex a task, and a pane opens beside the chat.');
		else vscode.window.showInformationMessage('Codex Sidecar is installed. Your agent has to be told how to call Codex through it: copy the instructions and paste them into the file it reads its instructions from.', 'Copy the instructions').then(choice => { if (choice) copySetup(); });
	}
}

// ---- telling the agent ----
// How to call Codex through the pane, in words for the agent that does the calling.
function instructions() {
	const at = path.join(HOME, LAUNCHER).replace(/\\/g, '/');
	const o = WINDOWS ? word => '-' + word[0].toUpperCase() + word.slice(1) : word => '--' + word;   // -Prompt there, --prompt here
	return [
		'To hand Codex a task, or ask it for a second opinion, write the task to a file and run:',
		'',
		'    ' + (WINDOWS ? 'powershell -ExecutionPolicy Bypass -File "' + at + '"' : 'bash "' + at + '"') + ' ' + o('prompt') + ' <task file> ' + o('out') + ' <answer file>',
		'',
		'The command returns when Codex is done; then read the answer file. The user watches Codex work in a pane beside this chat.',
		'',
		'- Codex cannot see this conversation. Put everything it needs into the task file.',
		'- Codex is read-only unless you add `' + o('sandbox') + ' workspace-write`.',
		'- Add `' + o('title') + ' "<a few words>"` to name the conversation on its tab, and `' + o('role') + ' "<one line>"` to say what Codex is there to do: the user sees both.',
		'- Other options: `' + o('model') + ' <name>`, `' + o('effort') + ' <low, medium or high>`, `' + o('dir') + ' <folder to work in>`, `' + o('name') + ' <the name shown on the pane>`.',
		'- A long task can outlast a command\'s time limit: run the command in the background.',
		'- The user can type to Codex in the pane while it works. When they did, the command\'s output ends with what they said: read it, and take it into account.',
		''
	];
}
// Agents read skills from folders of their own, whatever the project, so a skill of ours there means
// nobody has to paste anything anywhere. It is rewritten when it is out of date and taken away when
// the setting is switched off. Says whether the agents have been told.
function tellAgents() {
	const pages = {
		'SKILL.md': [
			'---',
			'name: codex-sidecar',
			'description: Hand a task to Codex, OpenAI\'s coding agent, or get its review or second opinion, while the user watches it work in a pane beside the chat in VS Code. Use when the user asks for Codex by name, for example to get, ask or bring in Codex, or for a Codex review.',
			'---',
			'',
			'# Codex as a helper (Codex Sidecar)',
			'',
			'This file is kept by the Codex Sidecar extension for VS Code, which rewrites it when VS Code starts. Its setting `codexSidecar.tellAgents` switches that off.',
			'',
			'Call Codex when the user asks for it, or when the project\'s instructions say to: a run spends the user\'s Codex allowance. If the project\'s own instructions say how to call Codex (a script of its own, a helper with a name), follow those instead of the command below. If you are Codex yourself, this is not for you: you are the helper here, so do the task.',
			''
		].concat(instructions()).join('\n'),
		// (Codex reads the shared folder too, and must not go looking for itself)
		'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n'
	};
	const on = config().get('tellAgents');
	let reached = false;   // (whether the skill is in at least one place)
	for (const { folder, needs } of SKILLS) {
		try {
			if (!on || !fs.existsSync(needs)) { fs.rmSync(folder, { recursive: true, force: true }); continue; }
			for (const name of Object.keys(pages)) {
				const page = path.join(folder, name);
				if (fs.existsSync(page) && fs.readFileSync(page, 'utf8') === pages[name]) continue;
				fs.mkdirSync(path.dirname(page), { recursive: true });
				fs.writeFileSync(page, pages[name]);
			}
			reached = true;
		} catch (e) { /* a folder we may not write in: that agent is told by hand */ }
	}
	return on && reached;
}

// ---- finding runs ----
function runIds() {
	try { return fs.readdirSync(RUNS).filter(name => name.endsWith('.run.json')).map(name => name.slice(0, -'.run.json'.length)).sort(); } catch (e) { return []; }
}
function sweep() {
	try {
		for (const name of fs.readdirSync(RUNS)) {
			const full = path.join(RUNS, name);
			if (Date.now() - fs.statSync(full).mtimeMs > WEEK) fs.unlinkSync(full);
		}
	} catch (e) { /* tidying can wait */ }
}
// A run belongs to this window when it was started from, or works in, one of its folders.
function mine(meta) {
	const norm = p => { const full = path.resolve(String(p)); return process.platform === 'win32' ? full.toLowerCase() : full; };
	const folders = (vscode.workspace.workspaceFolders || []).map(folder => norm(folder.uri.fsPath));
	return [meta.cwd, meta.dir].filter(Boolean).map(norm).some(p => folders.some(folder => p === folder || p.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep)));
}
// Which model Codex is really using, and at what effort. The event stream does not say; Codex's own
// record of the session does, in its "turn_context" line. Null until that line has been written.
function settingsOf(thread, started) {
	const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
	for (const shift of [0, -1, 1]) {   // (the record is filed under a date, which can fall either side of midnight)
		const day = new Date(started + shift * 24 * 3600 * 1000);
		const folder = path.join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
		try {
			const name = fs.readdirSync(folder).find(candidate => candidate.includes(thread));
			if (!name) continue;
			for (const line of fs.readFileSync(path.join(folder, name), 'utf8').split('\n')) {
				if (!line.includes('"turn_context"')) continue;
				const context = JSON.parse(line).payload || {};
				if (context.model) return { model: String(context.model), effort: String(context.effort || '') };
			}
		} catch (e) { /* no such day, or a line still being written */ }
	}
	return null;
}
// The tokens of a run still going. The event stream gives them only when a turn is over; Codex's own
// record keeps a running total ("token_count"), so that is read, from its last few lines.
function tokensSoFar(run) {
	if (!run.thread) return run.tokens;
	const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
	try {
		if (!run.record) {
			for (const shift of [0, -1, 1]) {
				const day = new Date(startedAt(run) + shift * 24 * 3600 * 1000);
				const folder = path.join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
				const name = fs.existsSync(folder) && fs.readdirSync(folder).find(candidate => candidate.includes(run.thread));
				if (name) { run.record = path.join(folder, name); break; }
			}
		}
		if (!run.record) return run.tokens;
		const size = fs.statSync(run.record).size;
		const tail = Buffer.alloc(Math.min(size, 65536));
		const fd = fs.openSync(run.record, 'r');
		fs.readSync(fd, tail, 0, tail.length, size - tail.length);
		fs.closeSync(fd);
		const counts = tail.toString('utf8').split('\n').filter(line => line.includes('"token_count"'));
		const u = JSON.parse(counts.pop()).payload.info.total_token_usage;
		return Math.max(run.tokens, (u.input_tokens || 0) - (u.cached_input_tokens || 0) + (u.output_tokens || 0));
	} catch (e) { return run.tokens; }   // no count yet, or a line still being written
}
function threadOf(lines) {
	for (const line of lines) {
		if (!line.includes('"thread.started"')) continue;
		try { return JSON.parse(line).thread_id || ''; } catch (e) { /* not that line */ }
	}
	return '';
}
function alive(pid) {
	if (!pid) return true;
	try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function announce(id, tries, resumed) {
	if (announced.has(id)) return;
	let meta;
	try { meta = readJson(file(id, 'run.json')); }
	catch (e) { if (tries < 40) setTimeout(() => announce(id, tries + 1, resumed), 50); return; }   // still being written
	if (announced.has(id)) return;
	announced.add(id);
	if (!mine(meta) || (resumed && !alive(meta.pid))) return;
	const run = { id, meta, pane: null, timer: null, ticks: 0, lost: false, result: null, tokens: 0 };
	rewind(run);
	following.set(id, run);
	run.timer = setInterval(() => pump(run), 200);
	if (config().get('openPanes') !== 'never') place(run, false);   // otherwise the marker in the status bar is all that shows
	mark(null);
	broadcast();
}

// ---- reading a run ----
function rewind(run) {
	run.offset = 0;
	run.rest = '';
	run.decoder = new StringDecoder('utf8');
	run.caughtUp = false;   // what is read first is old news: it is sent without the time it arrived
	run.tokens = 0;
}
function read(run) {
	try {
		const size = fs.statSync(file(run.id, 'events.jsonl')).size;
		if (size <= run.offset) return [];
		const fd = fs.openSync(file(run.id, 'events.jsonl'), 'r');
		const buffer = Buffer.alloc(size - run.offset);
		const got = fs.readSync(fd, buffer, 0, buffer.length, run.offset);
		fs.closeSync(fd);
		run.offset += got;
		const parts = (run.rest + run.decoder.write(buffer.subarray(0, got))).split('\n');
		run.rest = parts.pop();
		return parts.filter(line => line.trim());
	} catch (e) { return []; }   // not there yet
}
function resultOf(id) {
	let result;
	try { result = readJson(file(id, 'exit')); } catch (e) { return null; }
	let error = '';
	if (result.code && !result.stopped) try { error = fs.readFileSync(file(id, 'err'), 'utf8').trim().slice(-2500); } catch (e) { /* no error text */ }
	return { code: result.code || 0, stopped: !!result.stopped, error };
}
// The tokens Codex says a turn used, as Codex itself counts them: what it read afresh, and what it wrote.
function tokensIn(lines) {
	let sum = 0;
	for (const line of lines) {
		if (!line.includes('"turn.completed"')) continue;
		try { const u = JSON.parse(line).usage || {}; sum += (u.input_tokens || 0) - (u.cached_input_tokens || 0) + (u.output_tokens || 0); } catch (e) { /* not that line */ }
	}
	return sum;
}
function pump(run) {
	const done = fs.existsSync(file(run.id, 'exit'));   // looked at before reading, so nothing written ahead of it is missed
	const lines = read(run);
	if ((done || run.lost) && run.rest.trim()) { lines.push(run.rest); run.rest = ''; }
	if (lines.length) post(run.pane, { t: 'events', id: run.id, events: lines.map(line => ({ at: run.caughtUp ? Date.now() : null, line })) });
	run.tokens += tokensIn(lines);
	run.caughtUp = true;
	run.thread = run.thread || threadOf(lines);
	if (run.thread && !run.using && (run.looks = (run.looks || 0) + 1) <= 150 && run.looks % 3 === 1) {   // (for half a minute)
		run.using = settingsOf(run.thread, startedAt(run));
		if (run.using) {
			post(run.pane, { t: 'using', id: run.id, model: run.using.model, effort: run.using.effort });
			if (run.pane) { run.pane.using = run.using; retitle(run.pane); }
			mark(null);
		}
	}
	if (done) {
		const result = resultOf(run.id);
		if (!result && (run.unread = (run.unread || 0) + 1) < 15) return;   // the result is still being written
		return finish(run, result || { code: -1, stopped: false, error: '' });
	}
	// no result, and the launcher's Codex is gone: nothing more will come
	if (run.lost) return finish(run, { code: -1, stopped: false, error: 'The launcher went away before Codex reported how it ended.' });
	if (++run.ticks % 25 === 0 && !alive(run.meta.pid)) run.lost = true;   // one more read first, on the next tick
}
function finish(run, result) {
	clearInterval(run.timer);
	following.delete(run.id);
	run.result = result;
	const pane = run.pane;
	if (pane) {
		// (a page still loading reads the run back from its files when it is ready: see "ready")
		post(pane, { t: 'end', id: run.id, code: result.code, stopped: result.stopped, error: result.error, at: Date.now() });
		pane.run = null;
		pane.state = wordFor(result);
		retitle(pane);
		countdown(pane);
	}
	mark(run);
	broadcast();
}

// ---- tabs ----
function post(pane, message) {
	if (pane && pane.ready) pane.panel.webview.postMessage(message);
}
// A theme of the user's own: a name, the look it is laid out like, and its colours.
const PAINTS = ['background', 'text', 'dim', 'accent', 'bubble', 'card', 'line'];
function ownThemes(given) {
	const themes = {};
	if (!given || typeof given !== 'object') return themes;
	for (const name of Object.keys(given).slice(0, 24)) {
		const theme = given[name];
		const label = oneLine(name).slice(0, 40);
		if (!label || label === 'chatgpt' || label === 'claude' || !theme || typeof theme !== 'object') continue;
		const colors = {};
		for (const paint of PAINTS) if (/^#[0-9a-f]{6}$/i.test(String((theme.colors || {})[paint] || ''))) colors[paint] = String(theme.colors[paint]).toLowerCase();
		themes[label] = { base: theme.base === 'claude' ? 'claude' : 'chatgpt', colors };
	}
	return themes;
}
function sendPrefs(pane) {
	const logos = {};
	for (const look of Object.keys(BORROWED)) { const uri = borrowed(look); logos[look] = uri ? String(pane.panel.webview.asWebviewUri(uri)) : ''; }
	post(pane, { t: 'prefs', theme: config().get('theme'), zoom: config().get('textSize'), when: config().get('whenFinished'), minutes: config().get('closeAfterMinutes'), themes: ownThemes(config().get('themes')), logos });
}
const wordFor = result => (!result ? 'unfinished' : result.stopped ? 'stopped' : result.code ? 'failed' : 'done');
// The tab names the helper and the conversation, with a mark for how it ended.
function retitle(pane) {
	const mark = pane.run ? '' : { done: ' ✓', failed: ' ✕', stopped: ' ■' }[pane.state] || '';
	pane.panel.title = labelOf(pane.meta, pane.using) + ' · ' + titleOf(pane.meta) + mark;
	if (!pane.run && pane.state === 'failed') pane.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'tab-failed.png');   // (the mark, in red)
}
// A finished tab closes itself after a while, and its page counts the time down. It stays when the
// person says so, when it was opened by hand, and when the setting is 0.
function countdown(pane) {
	clearTimeout(pane.closing);
	pane.closesAt = 0;
	const when = config().get('whenFinished');   // "countdown", "close" (at once) or "stay"
	const minutes = when === 'stay' ? 0 : Number(config().get('closeAfterMinutes')) || 0;
	if (!pane.run && !pane.kept && pane.state !== 'failed') {   // (one that failed stays, to be read)
		if (when === 'close') { pane.panel.dispose(); return; }
		if (minutes > 0) {
			pane.closesAt = Date.now() + minutes * 60000;
			pane.closing = setTimeout(() => pane.panel.dispose(), minutes * 60000);
		}
	}
	post(pane, { t: 'closing', at: pane.closesAt, kept: pane.kept });
}
// Every page shows how many conversations there are, on the button that opens the overview.
function broadcast() {
	for (const pane of panes) post(pane, { t: 'tabs', open: panes.length, working: following.size });
}
// The overview: every conversation of this workspace that is still on record, newest first.
function overview() {
	const rows = [];
	for (const id of runIds().reverse()) {
		const live = following.get(id);
		let row = live ? null : told.get(id);
		if (!row) {
			let meta;
			try { meta = readJson(file(id, 'run.json')); } catch (e) { continue; }
			if (!mine(meta)) { told.set(id, { skip: true }); continue; }
			row = { id, name: labelOf(meta, live && live.using), title: titleOf(meta), role: roleOf(meta), started: Date.parse(meta.started) || 0 };
			if (!live) {
				const result = resultOf(id);
				row.state = wordFor(result);
				row.tokens = 0;
				try {
					const lines = fs.readFileSync(file(id, 'events.jsonl'), 'utf8').split('\n');
					row.tokens = tokensIn(lines);
					if (!meta.model) row.name = labelOf(meta, settingsOf(threadOf(lines.slice(0, 5)), row.started));   // (the model was left to Codex: its record says which)
				} catch (e) { /* its events have gone */ }
				if (result) told.set(id, row);   // (one with no ending on record may yet get one)
			}
		}
		if (row.skip || (!live && row.started < Date.now() - WEEK)) continue;   // (older than the week the totals speak of)
		rows.push(Object.assign({}, row, live ? { state: 'working', tokens: tokensSoFar(live) } : null, { open: panes.some(pane => pane.id === id) }));
	}
	return rows;
}
// The mark on a tab: the Codex Sidecar logo, in a shade for each kind of theme.
function tabIcon() {
	return { light: vscode.Uri.joinPath(extensionUri, 'media', 'tab-light.png'), dark: vscode.Uri.joinPath(extensionUri, 'media', 'tab-dark.png') };
}
// The marks of the two looks' namesakes, shown beside them in the list of looks. They are not ours to
// ship: each is shown from its maker's own extension, where that is installed, and left out where not.
const BORROWED = { chatgpt: ['openai.chatgpt', 'blossom-black.svg'], claude: ['anthropic.claude-code', 'claude-logo.svg'] };
function borrowed(look) {
	const from = vscode.extensions.getExtension(BORROWED[look][0]);
	const uri = from && vscode.Uri.joinPath(from.extensionUri, 'resources', BORROWED[look][1]);
	return uri && fs.existsSync(uri.fsPath) ? uri : null;
}
// Where a new conversation's tab goes: beside the editor when it is the first, else in front of the
// others, in the place the newest of them is in. It never opens a place of its own: whoever wants two
// side by side or one above the other drags a tab there.
function columnFor() {
	const newest = panes[panes.length - 1];
	return (newest && newest.panel.viewColumn) || vscode.ViewColumn.Beside;
}
function openPane(run, column, live, takeFocus) {
	const panel = vscode.window.createWebviewPanel('codexSidecar', labelOf(run.meta, run.using) + ' · ' + titleOf(run.meta), { viewColumn: column, preserveFocus: !takeFocus },
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), ...Object.keys(BORROWED).map(borrowed).filter(Boolean).map(uri => vscode.Uri.joinPath(uri, '..'))] });   // (the folders the borrowed marks are in)
	const pane = { panel, ready: false, id: run.id, meta: run.meta, using: run.using || null, run: live ? run : null, state: 'working', kept: false, closing: null, closesAt: 0 };
	panes.push(pane);
	panel.iconPath = tabIcon();
	panel.webview.onDidReceiveMessage(message => fromPage(pane, message));
	panel.onDidDispose(() => {
		clearTimeout(pane.closing);
		panes.splice(panes.indexOf(pane), 1);
		if (pane.run) pane.run.pane = null;   // it goes on, unseen
		broadcast();
	});
	const nonce = crypto.randomBytes(16).toString('hex');
	const media = leaf => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', leaf));
	panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('pane.css')}">
</head>
<body><script nonce="${nonce}" src="${media('pane.js')}"></script></body>
</html>`;
	return pane;
}
// Gives a conversation its tab, or brings forward the one it has. One opened by hand (from the
// overview, or as the latest run) takes the keyboard and stays until it is closed.
function place(run, byHand) {
	placing = placing.then(async () => {
		const open = panes.find(pane => pane.id === run.id);
		if (open) { open.panel.reveal(undefined, !byHand); return; }
		const live = following.has(run.id);   // (it may have ended while its turn came)
		const pane = openPane(run, columnFor(), live, byHand);
		if (live) {
			run.pane = pane;
		} else {
			pane.state = wordFor(run.result || resultOf(run.id));
			pane.kept = !!byHand;
			retitle(pane);
			countdown(pane);
		}
		broadcast();
	}).catch(() => { });
}
function begin(pane, run, live) {
	const m = run.meta;
	const using = run.using || {};
	// (the model and effort are what the launcher was told, until Codex's own record says what it used)
	post(pane, { t: 'start', run: { id: run.id, name: nameOf(m), title: titleOf(m), role: roleOf(m), model: using.model || m.model || '', effort: using.effort || m.effort || '', sandbox: m.sandbox || '', dir: m.dir || m.cwd || '', prompt: m.prompt || '', started: startedAt(run), live } });
}
// A run that is over, read back from its files in one go.
function showFinished(pane, id) {
	let meta;
	try { meta = readJson(file(id, 'run.json')); } catch (e) { return; }
	const run = { id, meta };
	rewind(run);
	const lines = read(run);
	if (run.rest.trim()) lines.push(run.rest);
	const thread = threadOf(lines);
	if (thread) run.using = settingsOf(thread, startedAt(run));
	if (run.using) { pane.using = run.using; retitle(pane); }
	const result = resultOf(id) || { code: -1, stopped: false, error: '' };
	begin(pane, run, false);
	post(pane, { t: 'events', id, events: lines.map(line => ({ at: null, line })) });
	post(pane, { t: 'end', id, code: result.code, stopped: result.stopped, error: result.error, at: null });
}
function fromPage(pane, message) {
	const known = /^[\w-]+$/.test(String(message.id || ''));
	if (message.t === 'ready') {
		pane.ready = true;
		sendPrefs(pane);
		if (pane.run) { rewind(pane.run); begin(pane, pane.run, true); }   // a new page starts its run from the top
		else showFinished(pane, pane.id);
		post(pane, { t: 'closing', at: pane.closesAt, kept: pane.kept });
		post(pane, { t: 'tabs', open: panes.length, working: following.size });
	} else if (message.t === 'pref') {
		const names = ['chatgpt', 'claude', ...Object.keys(ownThemes(config().get('themes')))];
		if (message.key === 'theme' && names.includes(message.value)) config().update('theme', message.value, vscode.ConfigurationTarget.Global);
		if (message.key === 'when' && ['countdown', 'close', 'stay'].includes(message.value)) config().update('whenFinished', message.value, vscode.ConfigurationTarget.Global);
		if (message.key === 'minutes' && message.value > 0 && message.value <= 120) config().update('closeAfterMinutes', message.value, vscode.ConfigurationTarget.Global);
		if (message.key === 'zoom' && message.value >= 70 && message.value <= 170) config().update('textSize', message.value, vscode.ConfigurationTarget.Global);
	} else if (message.t === 'themes') {   // the user's own themes, as the page's editor left them
		const themes = ownThemes(message.themes);
		const theme = ['chatgpt', 'claude', ...Object.keys(themes)].includes(message.theme) ? message.theme : 'chatgpt';
		config().update('themes', themes, vscode.ConfigurationTarget.Global).then(() => config().update('theme', theme, vscode.ConfigurationTarget.Global));
	} else if (message.t === 'stop' && known) {
		fs.writeFile(file(message.id, 'stop'), '', () => { });
	} else if (message.t === 'say' && known && following.has(message.id) && typeof message.text === 'string' && message.text.trim()) {
		// (the launcher reads this, stops what Codex is doing, and has it carry on with the message)
		fs.appendFile(file(message.id, 'say'), JSON.stringify({ at: new Date().toISOString(), text: message.text.trim().slice(0, 8000) }) + '\n', () => { });
	} else if (message.t === 'keep') {
		pane.kept = true;
		countdown(pane);
	} else if (message.t === 'overview') {
		post(pane, { t: 'overview', rows: overview() });
	} else if (message.t === 'show' && known) {
		show(message.id);
	} else if (message.t === 'open' && typeof message.path === 'string' && message.path) {
		openFile(path.resolve(typeof message.dir === 'string' ? message.dir : '', message.path));
	}
}
// Brings a conversation to the front: its tab if it has one, a new one if not.
function show(id) {
	try { place(following.get(id) || { id, meta: readJson(file(id, 'run.json')), result: resultOf(id) }, true); } catch (e) { /* its files have gone */ }
}
// A file Codex touched: its changes, where git has some to show; the file itself otherwise. It opens
// away from the panes, in the first place that is not one of ours, so the list stays in view.
async function openFile(target) {
	const uri = vscode.Uri.file(target);
	try { await vscode.workspace.fs.stat(uri); } catch (e) { vscode.window.showInformationMessage('Codex Sidecar: ' + target + ' is not there any more.'); return; }
	const ours = new Set(panes.map(pane => pane.panel.viewColumn));
	const elsewhere = vscode.window.tabGroups.all.find(group => !ours.has(group.viewColumn));
	await vscode.window.showTextDocument(uri, { viewColumn: elsewhere ? elsewhere.viewColumn : vscode.ViewColumn.Beside, preview: true });
	try {
		const git = vscode.extensions.getExtension('vscode.git');
		const repository = git && git.isActive && git.exports.getAPI(1).getRepository(uri);
		const same = other => (process.platform === 'win32' ? other.fsPath.toLowerCase() === uri.fsPath.toLowerCase() : other.fsPath === uri.fsPath);
		const change = repository && [...repository.state.workingTreeChanges, ...repository.state.indexChanges].find(one => same(one.uri));
		if (change) await vscode.commands.executeCommand('git.openChange', change.uri);   // (git's own spelling of the path: it matches by exact text)
	} catch (e) { /* no git here: the file itself will do */ }
}

// ---- the marker in the status bar ----
// Shows while a run of this window is going, and for a minute after the last one ends. A click
// brings up the latest run, which is how a pane is opened when "openPanes" is set to never.
function mark(ended) {
	clearTimeout(statusHide);
	const names = [...new Set([...following.values()].map(run => labelOf(run.meta, run.using)))];
	if (names.length) {
		statusItem.text = '$(loading~spin) ' + names.join(', ') + ' working';
		statusItem.show();
	} else if (ended) {
		const word = wordFor(ended.result);
		statusItem.text = (word === 'done' ? '$(check) ' : word === 'failed' ? '$(error) ' : '$(circle-slash) ') + labelOf(ended.meta, ended.using) + ' ' + word;
		statusItem.show();
		statusHide = setTimeout(() => statusItem.hide(), 60000);
	}
}

// ---- commands ----
function showLatest() {
	const id = runIds().filter(candidate => { try { return mine(readJson(file(candidate, 'run.json'))); } catch (e) { return false; } }).pop();
	if (!id) { vscode.window.showInformationMessage('Codex Sidecar: there are no runs for this workspace yet.'); return; }
	show(id);
}
function copySetup() {
	const text = ['## Codex as a helper (Codex Sidecar)', ''].concat(instructions()).join('\n');
	vscode.env.clipboard.writeText(text).then(() => vscode.window.showInformationMessage('Copied. Paste it into the file your agent reads its instructions from, such as AGENTS.md.'));
}

module.exports = { activate, deactivate() { } };
