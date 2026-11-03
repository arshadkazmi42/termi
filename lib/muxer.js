// Session-backend abstraction: termi drives terminal sessions through either
// GNU `screen` or `tmux`, chosen per session. One shared interface so the
// server can list / attach / watch / create / rename / resize / read-history
// without caring which multiplexer owns a given session.
//
// Why both: GNU screen 4.x downconverts 24-bit truecolor to a dim 16-color
// approximation, so colored CLIs/agents look washed out through a normal
// attach. tmux carries truecolor through intact. New sessions default to
// tmux (see pickCreateBackend); every existing `screen` session keeps working
// exactly as before — no migration, nothing orphaned.
//
// These are PURE command / arg / parser builders (no I/O), like screenctl.js
// and termfilter.js, so they unit-test cleanly. The server does the spawning.

const screenctl = require('./screenctl');
const { SAFE_SESSION } = screenctl;

// Single-quote for a POSIX shell (same contract as lib/remote.js `shq`).
function shq(s) { return `'` + String(s).replace(/'/g, `'\\''`) + `'`; }

// termi keeps its tmux sessions on a DEDICATED socket, isolated from any tmux
// the user runs on the box — so termi never mutates the user's own tmux
// server or its global options. (The ⚡ direct-terminal uses the same socket;
// its app sessions are named `termi-<app>` and the server filters them out of
// the normal session list.)
const TMUX = 'tmux -L termi';

// Truecolor + sane defaults for termi's tmux server. Idempotent; `\;` is the
// tmux command separator (escaped for the shell). Normal sessions pin their
// own size with `window-size manual` + resize-window (see createCmd /
// windowSizeCmd) so a second client — like the notification watcher — can't
// resize the window out from under the person viewing it. (The global default
// stays `latest` for the ⚡ direct terminal, which is single-client.)
const TMUX_OPTS = `${TMUX} set -g default-terminal tmux-256color \\; `
  + `set -ga terminal-overrides ',*:Tc' \\; set -g status off \\; `
  + `set -g window-size latest \\; set -g escape-time 10 \\; set -g destroy-unattached off`;

const TMUX_GUARD = `command -v tmux >/dev/null 2>&1 || { `
  + `printf '\\r\\n  tmux is not installed on this server.\\r\\n  termi needs it for this session (apt install tmux).\\r\\n'; `
  + `sleep 3; exit 127; }`;

// Attach to an EXISTING tmux session (creation is explicit, see createCmd).
// Sets truecolor options (idempotent) then exec-attaches, so a dropped pty
// cleanly detaches while the session keeps running in the tmux daemon.
function tmuxAttachScript(fullName) {
  return [
    TMUX_GUARD,
    `${TMUX_OPTS} >/dev/null 2>&1`,
    `exec ${TMUX} attach -t ${shq(fullName)}`,
  ].join('; ');
}

// `screen -ls` → sessions. Names are "<pid>.<name>"; the status is the last
// parenthesized field (some systems prepend a timestamp field).
function parseScreenList(output) {
  const sessions = [];
  for (const line of String(output || '').split('\n')) {
    const match = line.match(/^\t(\d+)\.(\S+)\t(.+)$/);
    if (!match) continue;
    const pid = match[1], name = match[2];
    const fields = [...match[3].matchAll(/\(([^)]*)\)/g)];
    if (!fields.length) continue;
    const statusRaw = fields[fields.length - 1][1].toLowerCase();
    const status = statusRaw.includes('attached') ? 'attached' : 'detached';
    sessions.push({ id: pid, pid, name, fullName: `${pid}.${name}`, status, backend: 'screen' });
  }
  return sessions;
}

// `tmux list-sessions -F '#{session_name}\t#{?session_attached,...}'`. tmux
// names have no pid prefix, so the name IS the identity (id == name == fullName).
function parseTmuxList(output) {
  const sessions = [];
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const name = line.slice(0, i);
    if (!name) continue;
    const status = line.slice(i + 1).toLowerCase().includes('attached') ? 'attached' : 'detached';
    sessions.push({ id: name, pid: name, name, fullName: name, status, backend: 'tmux' });
  }
  return sessions;
}

const screen = {
  name: 'screen',
  needsAgentPath: false,
  externalSize: true,            // the window size is set explicitly (width -w)
  detachKeys: '\x01d',           // Ctrl-A d — detach cleanly without killing
  extraEnv: {},
  listCmd: 'screen -ls',
  parseList: parseScreenList,
  // Local pty: spawn the `screen` binary directly.
  attachSpawn: (fullName) => ({ bin: 'screen', args: ['-A', '-x', fullName] }),
  attachRemoteCmd: (fullName) => `screen -A -x ${fullName}`,
  watchSpawn: (id) => ({ bin: 'screen', args: ['-x', String(id)] }),
  watchRemoteCmd: (id) => `screen -x ${id}`,
  createCmd: (name) => `screen -dmS ${name}`,
  renameCmd: (fullName, newName) => `screen -S ${fullName} -X sessionname ${newName}`,
  scrollbackCmd: (fullName, n) => `screen -S ${fullName} -X scrollback ${n}`,
  windowSizeCmd: (fullName, cols, rows) => screenctl.windowSizeCmd(fullName, cols, rows),
  historyMode: 'file',           // writes to a tmp file (read it back)
  historyCmd: (fullName, { tmp }) => `screen -S ${fullName} -X hardcopy -h ${tmp}`,
};

const tmux = {
  name: 'tmux',
  needsAgentPath: true,          // remote PATH may miss user install dirs
  externalSize: true,            // size is pinned per-session (window-size manual + resize-window)
  detachKeys: '',                // killing the client pty detaches; daemon keeps the session
  extraEnv: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  listCmd: `${TMUX} list-sessions -F '#{session_name}\t#{?session_attached,attached,detached}' 2>/dev/null`,
  parseList: parseTmuxList,
  // Local pty: run the attach script under a login shell.
  attachSpawn: (fullName) => ({ bin: 'bash', args: ['-lc', tmuxAttachScript(fullName)] }),
  attachRemoteCmd: (fullName) => tmuxAttachScript(fullName),
  watchSpawn: (id) => ({ bin: 'bash', args: ['-lc', tmuxAttachScript(String(id))] }),
  watchRemoteCmd: (id) => tmuxAttachScript(String(id)),
  // Set history-limit (truecolor opts too) BEFORE new-session so the first
  // pane gets the large scrollback that the history sheet reads via capture-pane.
  createCmd: (name, { cols = 80, rows = 24, scrollback = 10000 } = {}) =>
    `${TMUX_OPTS} \\; set -g history-limit ${scrollback} >/dev/null 2>&1; `
    + `${TMUX} new-session -d -s ${shq(name)} -x ${cols} -y ${rows}; `
    + `${TMUX} set-option -t ${shq(name)} window-size manual >/dev/null 2>&1`,
  renameCmd: (fullName, newName) => `${TMUX} rename-session -t ${shq(fullName)} ${shq(newName)}`,
  scrollbackCmd: (fullName, n) => `${TMUX} set-option -t ${shq(fullName)} history-limit ${n}`,
  // Pin the window to the viewer's size (window-size manual, set at create) so
  // the watcher's second client can't resize it. Mirrors screen's `width -w`.
  windowSizeCmd: (fullName, cols, rows) => {
    if (!SAFE_SESSION.test(String(fullName))) return null;
    const sz = screenctl.windowSize(cols, rows);
    if (!sz) return null;
    return `${TMUX} resize-window -t ${shq(fullName)} -x ${sz.cols} -y ${sz.rows}`;
  },
  historyMode: 'stdout',          // prints straight to stdout, no tmp file
  historyCmd: (fullName, { lines = 10000 } = {}) => `${TMUX} capture-pane -pt ${shq(fullName)} -S -${lines}`,
};

const BACKENDS = { screen, tmux };
function byName(n) { return BACKENDS[n] || null; }

// When the cache can't say which backend owns a name, infer from its shape:
// screen full names are "<pid>.<name>" (numeric-dot prefix); tmux names aren't.
function guess(fullName) { return /^\d+\./.test(String(fullName || '')) ? screen : tmux; }

// New sessions prefer tmux (truecolor); fall back to screen where tmux is absent.
function pickCreateBackend(probe) { return (probe && probe.hasTmux) ? tmux : screen; }

module.exports = {
  SAFE_SESSION, TMUX, screen, tmux, BACKENDS,
  byName, guess, pickCreateBackend,
  parseScreenList, parseTmuxList, tmuxAttachScript, shq,
};
