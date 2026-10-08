// Run by VS Code after the extension has been uninstalled, the next time VS Code starts. It takes
// away what the extension kept outside its own folder: the launcher and the runs, and the skill in
// the folders agents read. It leaves them be while another copy of the extension is still installed,
// here or in another editor of the same family (Cursor, VS Code Insiders and the like), since they
// all share those folders.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const own = path.dirname(__dirname);
// (every editor of the family keeps its extensions in ~/.<its name>/extensions)
const places = [own];
try {
	for (const name of fs.readdirSync(home)) {
		const place = path.join(home, name, 'extensions');
		if (name.startsWith('.') && place !== own && fs.existsSync(place)) places.push(place);
	}
} catch (e) { }
const others = [];
for (const place of places) {
	let gone = {};   // (the folders that editor has marked for removal)
	try { gone = JSON.parse(fs.readFileSync(path.join(place, '.obsolete'), 'utf8')); } catch (e) { }
	try { others.push(...fs.readdirSync(place).filter(name => /\.codex-sidecar(-vscode)?-\d/i.test(name) && path.join(place, name) !== __dirname && !gone[name])); } catch (e) { }
}
if (!others.length) {
	const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
	// (the same four places extension.js keeps the skill in)
	for (const skills of [path.join(claude, 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.gemini', 'config', 'skills'), path.join(home, '.gemini', 'antigravity-cli', 'skills')]) {
		fs.rmSync(path.join(skills, 'codex-sidecar'), { recursive: true, force: true });
	}
	fs.rmSync(path.join(home, '.codex-sidecar'), { recursive: true, force: true });
}
