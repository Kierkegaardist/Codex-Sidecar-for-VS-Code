# Changelog

## 1.0.2

- Confirmed other versions work: macOS and Linux are no longer experimental.
- Fixed there on the way: a task or a typed message with a backslash in it (a Windows path, say) could leave the run's record unreadable, so that no pane opened, or reach Codex changed.
- The pane also opens when the system reports a new run under its temporary name only.

## 1.0.1

- The packed file now says the extension is public, so the Marketplace lists it. Nothing in the extension differs from 1.0.0.

## 1.0.0

The first public release.

- Nothing in the extension differs from 0.1.1.
- From here the launcher's options and the names of the settings stay as they are; a change that breaks them would be a 2.0.
- The macOS and Linux launcher is still experimental.

## 0.1.1

- An experimental launcher for macOS and Linux (`sidecar.sh`), and `pack.sh` to build the extension there.
- A choice of what becomes of a finished tab: close at once, count down (1, 2, 5 or 10 minutes) or stay open.
- A conversation that failed keeps its tab open, marked in red, whatever that choice is.
- The overview shows the tokens of every tab, a working one included, and folds the earlier conversations away.
- The pane says in plain words what Codex may touch.
- Fixed: the launcher lost what was typed in the pane when Codex failed; uninstalling took away files another editor still needed; old runs were only cleared when VS Code started; the welcome could say nothing needed setting up when the skill had not been written.

## 0.1.0

The first version.

- A tab beside the chat for each conversation with Codex, showing its messages, commands and results as they happen, named after the helper, its model and the task.
- Stepping in: a message typed in the pane stops Codex and carries the same session on with what was said; the calling agent is told.
- An overview of every conversation of the week, with the totals for today and the week.
- Two looks, ChatGPT's and Claude Code's, and themes of your own.
- A skill that tells Claude Code, Cursor, Copilot in VS Code and Antigravity how to call Codex through the pane, so nothing needs setting up.
- For Windows.
