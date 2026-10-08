// Codex Sidecar: the page inside a tab. One tab holds one conversation with Codex.
//
// The extension sends: "prefs" (the look, the text size, the user's own themes), "start" (the
// conversation: the task the agent gave), "events" (lines of Codex's JSON event stream, as they are
// written), "using" (the model and effort Codex turned out to be on), "end" (it is over), "closing"
// (when this tab will close itself, if it will), "tabs" (how many conversations there are) and
// "overview" (all of them, for the overview). This file turns them into the page. It sends back
// "ready", "pref" and "themes" (preferences changed from the page), "stop", "say" (a message typed
// for Codex), "keep" (do not close this tab), "overview" (asking for it), "show" (bring a conversation
// forward) and "open" (a file Codex changed). Every look shares this markup; the stylesheet does the rest.
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const root = document.documentElement;
	const prefs = { theme: 'chatgpt', zoom: 100, themes: {}, when: 'countdown', minutes: 2 };
	const LOOKS = { chatgpt: 'ChatGPT', claude: 'Claude Code' };
	// what a theme of the user's own can colour, and the names those colours go by in the stylesheet
	const PAINTS = [['background', 'Background'], ['text', 'Text'], ['dim', 'Quiet text'], ['accent', 'Accent and links'], ['bubble', 'Messages to Codex'], ['card', 'Boxes'], ['line', 'Lines']];
	const VARS = ['--bg', '--fg', '--dim', '--faint', '--link', '--accent', '--bubble', '--card', '--card-head', '--line', '--chip', '--hover', '--select'];
	let state = null;                       // the conversation this tab holds
	let closing = { at: 0, kept: false };   // when this tab closes itself, or that it has been told to stay
	let tabs = { open: 1, working: 0 };
	let edited = 0;                         // when a theme was last changed here: what the extension echoes back just after is old news

	const el = (tag, cls, text) => {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	};
	const ICONS = {
		look: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 3v14"/><path d="M10 6.5h5.9M10 10h7M10 13.5h5.9"/></svg>',
		stop: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/></svg>',
		hub: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4.6" r="2.1"/><circle cx="4.6" cy="15" r="2.1"/><circle cx="15.4" cy="15" r="2.1"/><path d="M10 6.7v3.1M10 9.8 5.6 13.2M10 9.8l4.4 3.4"/></svg>',
		send: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"/></svg>'
	};

	// ---- the frame: the overview's button on its line, a bar, the feed, and the foot ----
	const top = el('div', 'top');
	const rail = el('div', 'rail');
	const hub = el('button', 'hub');
	hub.title = 'Every conversation with Codex in this project';
	hub.addEventListener('click', event => { event.stopPropagation(); toggle('overview'); });
	rail.append(hub);
	const bar = el('header', 'bar');
	const nameEl = el('span', 'name', 'Codex');
	const titleEl = el('span', 'title');
	const subEl = el('div', 'sub');
	const who = el('div', 'who');
	const first = el('div', 'who-line');
	first.append(nameEl, titleEl);
	who.append(first, subEl);
	const tools = el('div', 'tools');
	const tool = (title, inner, isHtml, click) => {
		const b = el('button');
		b.title = title;
		b.setAttribute('aria-label', title);
		if (isHtml) b.innerHTML = inner; else b.textContent = inner;
		b.addEventListener('click', click);
		tools.append(b);
		return b;
	};
	tool('The look of this pane, and themes of your own', ICONS.look, true, event => { event.stopPropagation(); toggle('looks'); });
	tool('Smaller text', 'A−', false, () => setPref('zoom', Math.max(70, prefs.zoom - 10)));
	tool('Bigger text', 'A+', false, () => setPref('zoom', Math.min(170, prefs.zoom + 10)));
	bar.append(who, tools);
	top.append(rail, bar);
	const feed = el('main', 'feed');
	const empty = el('div', 'empty', 'Nothing yet. When your agent hands Codex a task, the work shows here as it happens.');
	feed.append(empty);
	const foot = el('footer', 'foot');
	const sheet = el('div', 'sheet');
	sheet.hidden = true;
	sheet.addEventListener('click', event => event.stopPropagation());
	document.body.append(top, feed, foot, sheet);

	// ---- small helpers ----
	const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	const count = n => Number(n).toLocaleString('en-US');
	function span(ms) {
		const s = Math.max(0, Math.round(ms / 1000));
		return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
	}
	const nearEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 90;
	const toEnd = () => window.scrollTo(0, document.documentElement.scrollHeight);

	// ---- the look ----
	function applyPrefs() {
		const own = prefs.themes[prefs.theme];
		root.dataset.theme = own ? (own.base === 'claude' ? 'claude' : 'chatgpt') : (LOOKS[prefs.theme] ? prefs.theme : 'chatgpt');
		root.style.setProperty('--zoom', String(prefs.zoom / 100));
		const style = document.body.style;
		for (const name of VARS) style.removeProperty(name);
		if (!own) return;
		// a theme of the user's own: its colours laid over the look it is built on
		const c = own.colors || {};
		const set = (name, value) => { if (value) style.setProperty(name, value); };
		set('--bg', c.background); set('--fg', c.text); set('--dim', c.dim); set('--faint', c.dim);
		set('--link', c.accent); set('--accent', c.accent); set('--bubble', c.bubble); set('--card', c.card); set('--line', c.line);
		if (c.card && c.text) set('--card-head', 'color-mix(in srgb, ' + c.card + ' 90%, ' + c.text + ')');
		if (c.background && c.text) set('--chip', 'color-mix(in srgb, ' + c.background + ' 84%, ' + c.text + ')');
		if (c.text) set('--hover', 'color-mix(in srgb, ' + c.text + ' 10%, transparent)');
		if (c.accent) set('--select', 'color-mix(in srgb, ' + c.accent + ' 35%, transparent)');
	}
	function setPref(key, value) {
		prefs[key] = value;
		applyPrefs();
		vscode.postMessage({ t: 'pref', key, value });
	}
	let saving = null;
	function saveThemes() {
		edited = Date.now();
		applyPrefs();
		clearTimeout(saving);
		saving = setTimeout(() => vscode.postMessage({ t: 'themes', themes: prefs.themes, theme: prefs.theme }), 350);
	}
	// The colours of the look now showing, which a new theme starts from. (Anything see-through is
	// worked out as it looks on the background.)
	function coloursNow() {
		const css = getComputedStyle(document.body);
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext('2d');
		const hex = (value, under) => {
			ctx.fillStyle = under || '#000000';
			ctx.fillRect(0, 0, 1, 1);
			ctx.fillStyle = String(value || '').trim() || under || '#000000';
			ctx.fillRect(0, 0, 1, 1);
			const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
			return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
		};
		const get = name => css.getPropertyValue(name);
		const background = hex(get('--bg'));
		return {
			background, text: hex(get('--fg'), background), dim: hex(get('--dim'), background), accent: hex(get('--accent') || get('--link'), background),
			bubble: hex(get('--bubble') || get('--card'), background), card: hex(get('--card'), background), line: hex(get('--line'), background)
		};
	}

	// ---- the sheet: one floating panel, for the overview or for the looks ----
	let shown = '';
	let asking = null;
	let earlierOpen = false;   // whether the overview shows the conversations of earlier days
	// The foot of the overview: whose work this is, and where to say thanks. (It is made once and left
	// in place while the list above it is redrawn.)
	const ovBody = el('div', 'ov-body');
	const about = el('div', 'about');
	const logo = el('button', 'logo');
	logo.setAttribute('aria-label', 'Codex Sidecar, by Kierkegaardist');
	const thanks = el('a', 'kofi');   // (VS Code opens a link in the browser)
	thanks.href = 'https://ko-fi.com/kierkegaardist';
	thanks.append(el('span', 'heart', '♥'), el('span', '', 'Support on Ko-fi'));
	const aboutText = el('div', 'about-text');
	aboutText.append(el('div', 'about-name', 'Codex Sidecar'), el('div', 'about-by', 'by Kierkegaardist'), thanks);
	about.append(logo, aboutText);
	let knocks = 0;
	logo.addEventListener('click', () => {
		if (++knocks % 5 || about.querySelector('.pair')) return;
		const pair = el('i', 'pair');
		pair.addEventListener('animationend', () => pair.remove());
		about.append(pair);
	});
	function toggle(kind) {
		const again = shown === kind;
		closeSheet();
		if (again) return;
		shown = kind;
		sheet.className = 'sheet ' + kind;
		sheet.hidden = false;
		if (kind === 'looks') return looks();
		ovBody.replaceChildren(el('div', 'sheet-title', 'Codex in this project'), el('div', 'sheet-note', 'Looking…'));
		sheet.replaceChildren(ovBody, about);
		vscode.postMessage({ t: 'overview' });
		asking = setInterval(() => vscode.postMessage({ t: 'overview' }), 3000);
	}
	function closeSheet() {
		clearInterval(asking);
		shown = '';
		sheet.hidden = true;
		sheet.replaceChildren();
	}
	document.addEventListener('click', closeSheet);
	document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSheet(); });

	// The overview: who is at work and who was, what each was for, and what it has cost.
	function overview(rows) {
		if (shown !== 'overview') return;
		const midnight = new Date();
		midnight.setHours(0, 0, 0, 0);
		const sum = list => list.reduce((n, row) => n + (row.tokens || 0), 0);
		const parts = [el('div', 'sheet-title', 'Codex in this project')];
		const totals = el('div', 'totals');
		const total = (label, n) => { const box = el('div', 'total'); box.append(el('div', 'total-n', count(n)), el('div', 'total-l', label)); return box; };
		totals.append(total('tokens today', sum(rows.filter(row => row.started >= midnight.getTime()))), total('tokens, last 7 days', sum(rows)), total(rows.length === 1 ? 'conversation' : 'conversations', rows.length));
		totals.title = 'As Codex counts them: what it read afresh and what it wrote. A step that was cut off is not counted.';
		parts.push(totals);
		const group = (label, list) => {
			if (!list.length) return;
			if (label) parts.push(el('div', 'ov-group', label));
			for (const row of list) {
				const here = state && state.run.id === row.id;
				const item = el('button', 'ov-row' + (here ? ' here' : ''));
				const head = el('div', 'ov-head');
				head.append(el('span', 'dot ' + row.state), el('span', 'ov-name', row.name), el('span', 'ov-title', row.title), el('span', 'ov-when', here ? 'this tab' : clock(row.started)));
				const about = el('div', 'ov-role', row.role);
				const cost = el('div', 'ov-cost', (row.state === 'working' ? 'working' : row.state) + ' · ' + count(row.tokens || 0) + ' tokens' + (row.state === 'working' ? ' so far' : ''));
				item.append(head, about, cost);
				item.addEventListener('click', () => { closeSheet(); if (!here) vscode.postMessage({ t: 'show', id: row.id }); });
				parts.push(item);
			}
		};
		group('Open tabs', rows.filter(row => row.open));
		// (the earlier ones stay folded away until asked for, so the list of who is at work stays short)
		const earlier = rows.filter(row => !row.open);
		if (earlier.length) {
			const fold = el('button', 'ov-fold' + (earlierOpen ? ' open' : ''), 'Earlier, kept for a week (' + earlier.length + ')');
			fold.addEventListener('click', () => { earlierOpen = !earlierOpen; overview(rows); });
			parts.push(fold);
			if (earlierOpen) group('', earlier);
		}
		if (!rows.length) parts.push(el('div', 'sheet-note', 'No conversations yet.'));
		const at = sheet.scrollTop;
		ovBody.replaceChildren(...parts);
		sheet.scrollTop = at;
	}
	function hubLabel() {
		hub.innerHTML = ICONS.hub;
		hub.append(el('span', '', tabs.open === 1 ? '1 tab' : tabs.open + ' tabs'));
		hub.classList.toggle('busy', tabs.working > 0);
	}
	hubLabel();

	// The looks: the two that come with it, the user's own, and the making of those.
	function looks() {
		const parts = [el('div', 'sheet-title', 'Look')];
		const choose = name => {
			if (prefs.themes[name]) { prefs.theme = name; saveThemes(); } else setPref('theme', name);
			looks();
		};
		for (const name of [...Object.keys(LOOKS), ...Object.keys(prefs.themes)]) {
			const row = el('button', 'look-row' + (name === prefs.theme ? ' on' : ''));
			// (the mark of the look's namesake, where its own extension is there to show it from)
			const logo = (prefs.logos || {})[name];
			const mark = el(logo && name === 'claude' ? 'img' : 'i', 'mark');
			if (logo && name === 'claude') mark.src = logo;
			else if (logo) { mark.classList.add('ink'); mark.style.webkitMaskImage = mark.style.maskImage = 'url("' + logo + '")'; }
			row.append(el('span', 'radio'), mark, el('span', '', LOOKS[name] || name));
			row.addEventListener('click', () => choose(name));
			parts.push(row);
		}
		const fresh = el('button', 'look-row new', '+ New theme from this look');
		fresh.addEventListener('click', () => {
			let name = 'My theme';
			for (let n = 2; prefs.themes[name]; n++) name = 'My theme ' + n;
			prefs.themes[name] = { base: root.dataset.theme === 'claude' ? 'claude' : 'chatgpt', colors: coloursNow() };
			prefs.theme = name;
			saveThemes();
			looks();
		});
		parts.push(fresh);
		// what becomes of a tab once its conversation is over (it applies to the ones that finish from now on)
		parts.push(el('div', 'ov-group', 'When a conversation finishes'));
		const ends = el('div', 'bases');
		for (const [value, label] of [['close', 'Close at once'], ['countdown', 'Count down'], ['stay', 'Stay open']]) {
			const pick = el('button', 'base' + (prefs.when === value ? ' on' : ''), label);
			pick.addEventListener('click', () => { setPref('when', value); looks(); });
			ends.append(pick);
		}
		parts.push(ends);
		if (prefs.when === 'countdown') {
			const lengths = el('div', 'bases');
			lengths.append(el('span', 'bases-label', 'for'));
			for (const n of [1, 2, 5, 10]) {
				const pick = el('button', 'base' + (prefs.minutes === n ? ' on' : ''), n + ' min');
				pick.addEventListener('click', () => { setPref('minutes', n); looks(); });
				lengths.append(pick);
			}
			parts.push(lengths);
		}
		const own = prefs.themes[prefs.theme];
		if (own) {
			parts.push(el('div', 'ov-group', 'This theme'));
			const name = el('input', 'theme-name');
			name.type = 'text';
			name.maxLength = 40;
			name.value = prefs.theme;
			name.setAttribute('aria-label', 'The name of this theme');
			name.addEventListener('change', () => {
				const wanted = name.value.replace(/\s+/g, ' ').trim();
				if (!wanted || LOOKS[wanted.toLowerCase()] || prefs.themes[wanted]) { name.value = prefs.theme; return; }
				const renamed = {};
				for (const key of Object.keys(prefs.themes)) renamed[key === prefs.theme ? wanted : key] = prefs.themes[key];   // (it keeps its place in the list)
				prefs.themes = renamed;
				prefs.theme = wanted;
				saveThemes();
				looks();
			});
			parts.push(name);
			const bases = el('div', 'bases');
			bases.append(el('span', 'bases-label', 'Laid out like'));
			for (const base of Object.keys(LOOKS)) {
				const pick = el('button', 'base' + (own.base === base ? ' on' : ''), LOOKS[base]);
				pick.addEventListener('click', () => { own.base = base; saveThemes(); looks(); });
				bases.append(pick);
			}
			parts.push(bases);
			const grid = el('div', 'paints');
			for (const [key, label] of PAINTS) {
				const row = el('label', 'paint');
				const input = el('input');
				input.type = 'color';
				input.value = (own.colors || {})[key] || '#808080';
				input.addEventListener('input', () => { own.colors = own.colors || {}; own.colors[key] = input.value; saveThemes(); });
				row.append(input, el('span', '', label));
				grid.append(row);
			}
			parts.push(grid);
			const gone = el('button', 'look-row delete', 'Delete this theme');
			gone.addEventListener('click', () => {
				const base = own.base;
				delete prefs.themes[prefs.theme];
				prefs.theme = base;
				saveThemes();
				looks();
			});
			parts.push(gone);
		}
		sheet.replaceChildren(...parts);
	}

	// Long text is cut short with a "Show more" under it.
	function clamp(node, lines) {
		node.style.setProperty('--clamp', lines * 1.55 + 'em');
		node.classList.add('clamped');
		if (node.scrollHeight <= node.clientHeight + 6) { node.classList.remove('clamped'); return; }
		const more = el('button', 'more', 'Show more');
		more.addEventListener('click', () => {
			const open = node.classList.toggle('clamped');
			more.textContent = open ? 'Show more' : 'Show less';
		});
		node.after(more);
	}

	// Markdown, the small part of it Codex writes in. Everything is escaped before any tag is added.
	function inline(text) {
		return esc(text).split(/(`[^`]+`)/).map(part => {
			if (part.length > 2 && part[0] === '`' && part[part.length - 1] === '`') return '<code>' + part.slice(1, -1) + '</code>';
			return part
				.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
				.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
				.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
		}).join('');
	}
	function markdown(text) {
		const lines = String(text || '').replace(/\r/g, '').split('\n');
		const out = [];
		let para = [];
		const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
		const LIST = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
		for (let i = 0; i < lines.length;) {
			const line = lines[i];
			let m;
			if ((m = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line))) {
				flush();
				const code = [];
				for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
				i++;
				out.push('<div class="code">' + (m[1] ? '<div class="code-head">' + esc(m[1]) + '</div>' : '') + '<pre>' + esc(code.join('\n')) + '</pre></div>');
			} else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
				flush();
				const level = Math.min(m[1].length + 2, 5);
				out.push('<h' + level + '>' + inline(m[2]) + '</h' + level + '>');
				i++;
			} else if (LIST.test(line)) {
				flush();
				const ordered = /^\s*\d/.test(line);
				const items = [];
				for (; i < lines.length; i++) {
					if ((m = LIST.exec(lines[i]))) items.push({ sub: m[1].length >= 2, text: [m[3]] });
					else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1].text.push(lines[i].trim());
					else break;
				}
				const start = ordered ? parseInt(line, 10) || 1 : 1;
				out.push((ordered ? '<ol start="' + start + '">' : '<ul>') + items.map(it => '<li' + (it.sub ? ' class="sub"' : '') + '>' + it.text.map(inline).join('<br>') + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
			} else if (/^\s*\|.*\|\s*$/.test(line)) {
				flush();
				const rows = [];
				for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i].trim());
				out.push('<div class="code"><pre>' + esc(rows.join('\n')) + '</pre></div>');
			} else if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
				flush(); out.push('<hr>'); i++;
			} else if (!line.trim()) {
				flush(); i++;
			} else {
				para.push(line); i++;
			}
		}
		flush();
		return out.join('');
	}

	// Codex wraps each command in a shell ("powershell.exe -Command '...'", "bash -lc '...'"); show what is inside.
	function tidy(command) {
		let c = String(command || '').trim();
		let m;
		let windows = false;
		if ((m = /^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-No\w+\s+)*-Command\s+([\s\S]+)$/i.exec(c))) { c = m[1]; windows = true; }
		else if ((m = /^(?:\S*[\\/])?(?:bash|zsh|sh)(?:\.exe)?\s+-l?c\s+([\s\S]+)$/.exec(c))) c = m[1];
		else return c;
		c = c.trim();
		if (c.length > 1 && (c[0] === "'" || c[0] === '"') && c[c.length - 1] === c[0]) c = c.slice(1, -1);
		// (on Windows, Codex writes the command with every \ doubled and every " escaped)
		if (windows) c = c.replace(/\\(["\\])/g, '$1');
		return c;
	}
	function shortPath(file) {
		const dir = String(state.run.dir || '').replace(/[\\/]+$/, '');
		const f = String(file || '');
		return dir && f.toLowerCase().startsWith(dir.toLowerCase()) ? f.slice(dir.length).replace(/^[\\/]+/, '') : f;
	}
	function words(value) {
		if (value === undefined || value === null) return '';
		if (typeof value === 'string') return value;
		try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
	}

	// A file Codex changed, as something to click: the extension opens its changes, or the file.
	const KINDS = { add: 'Added', delete: 'Deleted', update: 'Edited' };
	function fileLink(change) {
		const label = shortPath(change.path);
		if (change.kind === 'delete') return el('span', 'file gone', label);
		const link = el('button', 'file', label);
		link.title = 'Open ' + change.path;
		link.addEventListener('click', () => vscode.postMessage({ t: 'open', path: change.path, dir: state.run.dir || '' }));
		return link;
	}
	function fileList(changes) {
		const box = el('div', 'tool-box files');
		for (const change of changes) {
			const row = el('div', 'row');
			row.append(el('span', 'kind', KINDS[change.kind] || 'Changed'), fileLink(change));
			box.append(row);
		}
		return box;
	}

	// ---- one step of Codex's work: a line of talk, a thought, a command, a file ----
	function toolRow(name, desc, word, rows) {
		const parts = [];
		const head = el('div', 'tool-head');
		const about = el('span', 'desc');
		if (desc instanceof Node) about.append(desc); else about.textContent = desc || '';
		head.append(el('span', 'tool-name', name), about);
		if (word) head.append(el('span', 'state', word));
		parts.push(head);
		const filled = (rows || []).filter(r => r[1]);
		if (filled.length) {
			const box = el('div', 'tool-box');
			for (const [label, text] of filled) {
				const row = el('div', 'row ' + label.toLowerCase());
				const pre = el('pre', '', text);
				row.append(el('span', 'lab', label), pre);
				box.append(row);
			}
			parts.push(box);
		}
		return parts;
	}
	function build(it, finished, took) {
		const failed = it.status === 'failed' || it.status === 'declined' || (typeof it.exit_code === 'number' && it.exit_code !== 0) || !!it.error;
		const mood = finished ? (failed ? 'fail' : 'ok') : 'busy';
		switch (it.type) {
			case 'agent_message': {
				const body = el('div', 'markdown');
				body.innerHTML = markdown(it.text);
				return { cls: 'message', parts: [body] };
			}
			case 'reasoning': {
				const text = String(it.text || '').trim();
				const title = /^\*\*([^*]+)\*\*/.exec(text);
				const details = el('details');
				details.append(el('summary', '', (took > 900 ? 'Thought for ' + span(took) : 'Thought') + (title ? ': ' + title[1] : '')));
				const body = el('div', 'thinking markdown');
				body.innerHTML = markdown(title ? text.slice(title[0].length) : text);
				if (body.textContent.trim()) details.append(body); else details.classList.add('bare');
				return { cls: 'thought', parts: [details] };
			}
			case 'command_execution': {
				const command = tidy(it.command);
				const word = !finished ? 'running' : typeof it.exit_code === 'number' ? 'exit ' + it.exit_code : it.status || '';
				return { cls: 'tool boxed ' + mood, parts: toolRow('Shell', command.split('\n')[0], word, [['IN', command], ['OUT', String(it.aggregated_output || '').replace(/\r/g, '').replace(/^\n+|\s+$/g, '')]]), clampOut: true };
			}
			case 'file_change': {
				const changes = (it.changes || []).filter(change => change && change.path);
				if (finished && !failed) for (const change of changes) state.files.set(change.path, change.kind);
				if (changes.length === 1) return { cls: 'tool ' + mood, parts: toolRow(KINDS[changes[0].kind] || 'Changed', fileLink(changes[0]), failed ? 'failed' : '') };
				return { cls: 'tool boxed ' + mood, parts: [...toolRow('Files', changes.length + ' changed', failed ? 'failed' : ''), fileList(changes)] };
			}
			case 'mcp_tool_call':
				return { cls: 'tool boxed ' + mood, parts: toolRow([it.server, it.tool].filter(Boolean).join('.') || 'Tool', '', failed ? 'failed' : finished ? '' : 'running', [['IN', words(it.arguments)], ['OUT', words(it.error ? it.error.message || it.error : it.result)]]), clampOut: true };
			case 'web_search':
				return { cls: 'tool ' + mood, parts: toolRow('Web search', it.query || '', '') };
			case 'todo_list': {
				const list = el('ul', 'todo');
				for (const todo of it.items || []) {
					const li = el('li', todo.completed ? 'done' : '');
					li.append(el('span', 'box'), el('span', '', todo.text || ''));
					list.append(li);
				}
				return { cls: 'plan', parts: [list] };
			}
			case 'error':
				return { cls: 'tool fail', parts: toolRow('Error', it.message || '', '') };
			default:
				return { cls: 'tool ' + mood, parts: toolRow(String(it.type || 'step').replace(/_/g, ' '), it.text || it.message || '', '') };
		}
	}
	function step(it, finished, at) {
		const key = state.part + ':' + it.id;   // (Codex numbers its steps afresh each time it is carried on)
		let slot = state.items.get(key);
		if (!slot) {
			slot = { node: el('div', 'item'), since: state.last };
			state.items.set(key, slot);
			state.work.append(slot.node);
		}
		const made = build(it, finished, at && slot.since ? at - slot.since : 0);
		slot.node.className = 'item ' + made.cls;
		slot.node.replaceChildren(...made.parts);
		if (made.clampOut) {
			const out = slot.node.querySelector('.row.out pre');
			if (out) clamp(out, 12);
		}
	}
	function note(cls, name, text) {
		const node = el('div', 'item tool ' + cls);
		node.append(...toolRow(name, '', '', [['OUT', text]]));
		state.work.append(node);
	}
	// Whatever is still marked as going on did not finish.
	function unfinished(mood, word) {
		state.items.forEach(slot => {
			if (!slot.node.classList.contains('busy')) return;
			slot.node.classList.replace('busy', mood);
			const label = slot.node.querySelector('.state');
			if (label) label.textContent = word;
		});
	}
	// What the person watching typed for Codex, where it fell in the work.
	function yours(text, label) {
		const node = el('div', 'item you');
		const body = el('div', 'you-body');
		body.append(el('div', 'you-text', text));
		node.append(el('div', 'you-meta', label), body);
		return node;
	}

	function onEvent(at, line) {
		let ev = null;
		line = line.replace(/^﻿/, '');
		try { ev = JSON.parse(line); } catch (e) { /* not JSON: shown as it is, below */ }
		if (!ev || typeof ev !== 'object' || !ev.type) {
			if (line.trim() && line.trim()[0] !== '{') note('plain', 'Output', line);   // (a line starting like an event is one Codex was stopped in the middle of writing)
		} else if (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed') {
			if (ev.item) step(ev.item, ev.type === 'item.completed', at);
		} else if (ev.type === 'turn.completed') {
			const u = ev.usage || {};
			state.tokens += (u.input_tokens || 0) - (u.cached_input_tokens || 0) + (u.output_tokens || 0);
		} else if (ev.type === 'sidecar.said') {
			unfinished('cut', 'interrupted');
			const node = state.pending.shift() || yours(String(ev.text || ''), '');
			node.querySelector('.you-meta').textContent = (ev.cut ? 'You stepped in' : 'You added') + (at ? ' · ' + clock(at) : '');
			node.classList.remove('waiting');
			state.work.append(node);
			state.part++;
		} else if (ev.type === 'turn.failed' || ev.type === 'error') {
			note('fail', 'Error', (ev.error && ev.error.message) || ev.message || 'Codex reported an error.');
		} else if (ev.type !== 'thread.started' && ev.type !== 'turn.started') {
			note('plain', String(ev.type), ev.message || ev.text || line);   // a kind of event this page does not know: shown as it came
		}
		if (at) state.last = at;
	}

	// ---- the conversation: the task, the work, and a line of status under it ----
	function status() {
		const s = state.status;
		s.replaceChildren();
		if (!state.ended) {
			s.className = 'status busy';
			state.ticker = el('span', 'elapsed');
			s.append(el('span', 'spin'), el('span', '', 'Working'), state.ticker);
			if (state.run.live) {
				const stop = el('button', 'stop');
				stop.title = 'Stop this run';
				stop.innerHTML = ICONS.stop + '<span>Stop</span>';
				stop.addEventListener('click', () => { stop.disabled = true; vscode.postMessage({ t: 'stop', id: state.run.id }); });
				s.append(stop);
			}
			tick();
			return;
		}
		const end = state.ended;
		const bits = [];
		if (end.stopped) bits.push('Stopped');
		else if (end.code) bits.push('Failed (exit ' + end.code + ')');
		else bits.push(end.at ? 'Done in ' + span(end.at - state.run.started) : 'Done');
		if (state.tokens) bits.push(count(state.tokens) + ' tokens');
		s.className = 'status ' + (end.stopped ? 'stopped' : end.code ? 'fail' : 'done');
		s.append(el('span', '', bits.join(' · ')));
		if (end.error && !end.stopped) {
			const failure = el('pre', 'failure', end.error);
			s.after(failure);
		}
	}
	function tick() {
		if (state && state.ticker && !state.ended) state.ticker.textContent = span(Date.now() - state.run.started);
		const left = foot.querySelector('.left');
		if (left && closing.at) left.textContent = span(Math.max(0, closing.at - Date.now()));
	}
	setInterval(tick, 1000);

	// The bar names the helper and the conversation, then the model and effort, then what it may touch.
	function heading() {
		const run = state.run;
		const name = run.name || 'Codex';
		const number = (String(run.model || '').match(/\d+(?:\.\d+)+|\d+/) || [''])[0];   // "6.1" of gpt-6.1-sol
		nameEl.textContent = number && !name.includes(number) ? name + ' ' + number : name;
		titleEl.textContent = run.title || '';
		// (what it may touch, in plain words: "read-only" read as if it could do nothing at all)
		const may = { 'read-only': 'runs commands, cannot change files', 'workspace-write': 'can change files in its folder', 'danger-full-access': 'can change anything' }[run.sandbox] || run.sandbox;
		subEl.textContent = [run.model, run.effort && run.effort + ' effort', may].filter(Boolean).join(' · ');
	}
	// The foot: while Codex works, a place to type to it; once it is over, when this tab will close.
	function footing() {
		if (!state) return;
		if (!state.ended) {
			if (!state.run.live || foot.querySelector('.say')) return;   // (what has been typed stays as it is)
			const say = el('div', 'say');
			const box = el('textarea');
			box.rows = 1;
			box.placeholder = 'Step in: type a message for Codex. Sending it stops what Codex is doing, and it carries on with what you said.';
			const grow = () => { box.style.height = 'auto'; box.style.overflowY = box.scrollHeight > 180 ? 'auto' : 'hidden'; box.style.height = Math.min(box.scrollHeight, 180) + 'px'; };
			const send = el('button', 'send');
			send.title = 'Stop Codex and send this';
			send.innerHTML = ICONS.send;
			const go = () => {
				const text = box.value.trim();
				if (!text || state.ended) return;
				vscode.postMessage({ t: 'say', id: state.run.id, text });
				box.value = '';
				grow();
				const node = yours(text, 'Sending: Codex is being stopped…');
				node.classList.add('waiting');
				state.pending.push(node);
				state.work.append(node);
				toEnd();
			};
			box.addEventListener('input', grow);
			box.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); go(); } });
			send.addEventListener('click', go);
			say.append(box, send);
			foot.replaceChildren(say, el('div', 'fine', 'Each message costs Codex allowance, and your agent is told what you said. Shift+Enter for a new line.'));
			grow();
			window.addEventListener('resize', grow);
			return;
		}
		const row = el('div', 'closing');
		if (closing.at) {
			const keep = el('button', 'keep', 'Stop the countdown');
			keep.title = 'Keep this tab open until you close it';
			keep.addEventListener('click', () => vscode.postMessage({ t: 'keep' }));
			row.append(el('span', '', 'This tab closes in '), el('span', 'left', span(Math.max(0, closing.at - Date.now()))), keep);
		} else {
			const failed = state.ended.code && !state.ended.stopped;
			row.append(el('span', '', failed ? 'This one failed, so it stays here until you close the tab.' : closing.kept ? 'Kept: this conversation stays here until you close the tab.' : 'This conversation is over.'));
		}
		foot.replaceChildren(row, el('div', 'fine', 'It can be opened again for a week from the overview. To carry it on, ask your agent.'));
	}
	function start(run) {
		if (state) return;
		empty.remove();
		const section = el('section', 'run');
		const ask = el('div', 'ask');
		const meta = el('div', 'ask-meta');
		meta.append(el('span', '', 'Your agent asked'), el('span', '', clock(run.started)));
		const body = el('div', 'ask-body');
		const text = el('div', 'ask-text', String(run.prompt || '').trim());
		body.append(text);
		ask.append(meta, body);
		const work = el('div', 'work');
		state = { run, work, status: el('div', 'status'), items: new Map(), files: new Map(), pending: [], part: 0, last: run.live ? run.started : 0, tokens: 0, ended: null, ticker: null };
		section.append(ask, work, state.status);
		feed.append(section);
		clamp(text, 7);
		heading();
		status();
		footing();
		toEnd();
	}
	function end(m) {
		if (!state || state.run.id !== m.id || state.ended) return;
		state.ended = { code: m.code || 0, stopped: !!m.stopped, error: m.error || '', at: m.at || 0 };
		document.body.classList.toggle('failed', !!m.code && !m.stopped);   // (a failed one is marked in red)
		unfinished(m.code || m.stopped ? 'fail' : 'ok', m.stopped ? 'stopped' : 'unfinished');
		for (const node of state.pending) {   // typed too late: the launcher had gone
			node.querySelector('.you-meta').textContent = 'Not passed on: Codex had already finished';
			node.classList.remove('waiting');
		}
		state.pending = [];
		if (state.files.size) {   // what the run changed, gathered in one place
			const changed = el('div', 'changed');
			changed.append(el('div', 'changed-title', state.files.size === 1 ? '1 file changed' : state.files.size + ' files changed'),
				fileList([...state.files].map(([file, kind]) => ({ path: file, kind }))));
			state.status.before(changed);
		}
		status();
		footing();
	}

	window.addEventListener('message', event => {
		const m = event.data || {};
		const stick = nearEnd();
		if (m.t === 'prefs') {
			if (m.zoom) prefs.zoom = m.zoom;
			if (m.logos) prefs.logos = m.logos;
			if (m.when) prefs.when = m.when;
			if (m.minutes) prefs.minutes = m.minutes;
			if (Date.now() - edited > 1500) {
				if (m.themes && typeof m.themes === 'object') prefs.themes = m.themes;
				if (m.theme) prefs.theme = m.theme;
			}
			applyPrefs();
		} else if (m.t === 'start') {
			start(m.run);
		} else if (m.t === 'events') {
			if (state && state.run.id === m.id) for (const e of m.events) onEvent(e.at, e.line);
		} else if (m.t === 'using') {   // Codex's own record of the model and effort it is on
			if (state && state.run.id === m.id) { state.run.model = m.model; state.run.effort = m.effort; heading(); }
		} else if (m.t === 'end') {
			end(m);
		} else if (m.t === 'closing') {
			closing = { at: m.at || 0, kept: !!m.kept };
			if (state && state.ended) footing();
		} else if (m.t === 'tabs') {
			tabs = { open: m.open || 1, working: m.working || 0 };
			hubLabel();
		} else if (m.t === 'overview') {
			overview(m.rows || []);
		}
		if (stick) toEnd();
	});
	applyPrefs();
	vscode.postMessage({ t: 'ready' });
})();
