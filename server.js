const express = require('express');
const { exec, spawn } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const util = require('util');
const os = require('os');

const registry = require('./lib/registry');
const remote = require('./lib/remote');
const monitor = require('./lib/monitor');
const notify = require('./lib/notify');
const { altScreenFilter, cleanHardcopy } = require('./lib/termfilter');
const { SAFE_SESSION } = require('./lib/screenctl');
const muxer = require('./lib/muxer');

const execAsync = util.promisify(exec);

// ── Resolve agent binary path ─────────────────────────────
const EXTRA_PATHS = [
  '/Users/arshad/.local/bin',    // confirmed agent location
  '/opt/homebrew/bin',           // macOS Apple Silicon brew
  '/usr/local/bin',              // macOS Intel brew + Linux
  '/usr/bin',
  `${os.homedir()}/.local/bin`,
  `${os.homedir()}/.cursor/bin`,
  `${os.homedir()}/.opencode/bin`,  // opencode's installer puts the binary here
].join(':');

const AGENT_ENV = {
  ...process.env,
  PATH: `${EXTRA_PATHS}:${process.env.PATH || ''}`
};

let AGENT_BIN = process.env.AGENT_BIN || `${os.homedir()}/.local/bin/agent`;
console.log(`[termi] using agent binary: ${AGENT_BIN}`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 300000,       // 5 min — handles long agent operations
  pingInterval: 10000,       // ping every 10s to keep mobile alive
  upgradeTimeout: 30000,
  transports: ['websocket', 'polling'], // fallback to polling if websocket drops
});

app.use(express.static(path.join(__dirname, 'public')));

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const PORT = process.env.PORT || 3619;
const WORK_DIR = process.env.WORK_DIR || '/root/workspace';
const CLAUDE_USER = process.env.CLAUDE_USER || 'termi';
const LOCAL_ID = 'local';

registry.setSecret(AUTH_TOKEN);

// ── Attachment uploads ────────────────────────────────
// Files/screenshots for the agent land on the TARGET server so the CLI
// there can read them by path: WORK_DIR/.termi/uploads locally,
// ~/.termi-uploads over SFTP for remote servers.
const UPLOAD_DIR = path.join(WORK_DIR, '.termi', 'uploads');
const UPLOAD_MAX = 15 * 1024 * 1024;
const UPLOAD_TTL = 7 * 24 * 3600 * 1000;

function pruneUploads() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > UPLOAD_TTL) fs.unlinkSync(p);
    }
  } catch (_) {}
}
pruneUploads();

app.post('/upload', express.raw({ type: () => true, limit: UPLOAD_MAX }), async (req, res) => {
  if (req.headers['x-termi-token'] !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty upload' });
  const serverId = String(req.query.serverId || LOCAL_ID);
  // Unique prefix + sanitized original name: collision-safe, still readable.
  const safe = String(req.query.name || 'file').replace(/[^\w.\-]+/g, '-').replace(/^[.\-]+/, '').slice(-80) || 'file';
  const name = Date.now().toString(36) + '-' + safe;
  try {
    if (serverId === LOCAL_ID) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o755 });
      const p = path.join(UPLOAD_DIR, name);
      fs.writeFileSync(p, req.body, { mode: 0o644 }); // world-readable: claude runs as CLAUDE_USER
      return res.json({ path: p });
    }
    const { stdout } = await remote.execOnServer(serverId, 'mkdir -p ~/.termi-uploads && echo "$HOME"');
    const home = stdout.trim().split('\n').pop();
    if (!home || !home.startsWith('/')) throw new Error('could not resolve remote home dir');
    await remote.uploadBuffer(serverId, req.body, `.termi-uploads/${name}`);
    res.json({ path: `${home}/.termi-uploads/${name}` });
  } catch (err) {
    console.log('[upload] failed:', serverId, err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── File downloads ────────────────────────────────────
// Deliberately narrow: only regular files under /tmp, symlinks resolved
// BEFORE the check so /tmp/evil -> /etc/shadow can't escape. Token comes in
// a header (fetch → blob client-side), never in the URL.
const DOWNLOAD_ROOT = '/tmp/';
const DOWNLOAD_MAX = 100 * 1024 * 1024;

app.get('/download', async (req, res) => {
  if (req.headers['x-termi-token'] !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const serverId = String(req.query.serverId || LOCAL_ID);
  const asked = path.posix.normalize(String(req.query.path || ''));
  if (!asked.startsWith(DOWNLOAD_ROOT)) return res.status(403).json({ error: 'only files under /tmp can be downloaded (for now)' });
  const fname = (path.posix.basename(asked) || 'file').replace(/[^\w.\-]+/g, '-');
  const serve = (size, stream) => {
    console.log('[download]', serverId, asked, size, 'bytes');
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', size);
    res.setHeader('content-disposition', `attachment; filename="${fname}"`);
    stream.on('error', () => { try { res.destroy(); } catch (_) {} });
    stream.pipe(res);
  };
  try {
    if (serverId === LOCAL_ID) {
      const real = fs.realpathSync(asked);
      if (!real.startsWith(DOWNLOAD_ROOT)) return res.status(403).json({ error: 'path resolves outside /tmp' });
      const st = fs.statSync(real);
      if (!st.isFile()) return res.status(400).json({ error: 'not a regular file' });
      if (st.size > DOWNLOAD_MAX) return res.status(413).json({ error: 'file larger than 100MB' });
      return serve(st.size, fs.createReadStream(real));
    }
    const dl = await remote.openDownload(serverId, asked);
    if (!dl.real.startsWith(DOWNLOAD_ROOT)) { dl.close(); return res.status(403).json({ error: 'path resolves outside /tmp' }); }
    if (!dl.isFile) { dl.close(); return res.status(400).json({ error: 'not a regular file' }); }
    if (dl.size > DOWNLOAD_MAX) { dl.close(); return res.status(413).json({ error: 'file larger than 100MB' }); }
    serve(dl.size, dl.stream());
  } catch (err) {
    res.status(404).json({ error: err.code === 'ENOENT' ? 'file not found' : err.message });
  }
});

// ── Per-server chat state ─────────────────────────────
// Each target (local box or SSH server) gets its own queue + session.
const chats = new Map(); // serverId → state

function chatState(serverId) {
  let st = chats.get(serverId);
  if (!st) {
    st = {
      queue: [], hasSession: false, agentRunning: false,
      agentType: serverId === LOCAL_ID ? (process.env.AGENT_TYPE || 'agent') : 'claude',
      lastResponse: null, pendingOutput: '',
    };
    chats.set(serverId, st);
  }
  return st;
}

function emitQueue(serverId) {
  io.emit('queue', { serverId, queue: chatState(serverId).queue });
}

async function processQueue(serverId) {
  const st = chatState(serverId);
  if (st.agentRunning || st.queue.length === 0) return;

  const next = st.queue.shift();
  emitQueue(serverId);

  st.agentRunning = true;
  st.pendingOutput = '';
  st.lastResponse = null;

  io.emit('response', { serverId, type: 'thinking', content: `Running: ${next.message}` });

  // Keepalive — emit heartbeat every 20s so mobile knows agent is still working
  const keepalive = setInterval(() => {
    if (st.agentRunning) {
      io.emit('keepalive', { serverId, running: true });
      console.log('[keepalive]', serverId, 'agent still running, output length:', st.pendingOutput.length);
    }
  }, 20000);

  try {
    const output = await runActive(serverId, next.message, (chunk) => {
      st.pendingOutput = chunk;
      io.emit('response', { serverId, type: 'thinking', content: chunk });
    });

    clearInterval(keepalive);
    st.hasSession = true;
    st.agentRunning = false;

    st.lastResponse = { serverId, type: 'agent', content: output };
    st.pendingOutput = '';

    console.log('[agent]', serverId, 'completed, emitting final response, length:', output.length);
    io.emit('response', st.lastResponse);

  } catch (err) {
    clearInterval(keepalive);
    st.agentRunning = false;
    st.lastResponse = { serverId, type: 'error', content: err.message };
    io.emit('response', st.lastResponse);
  }

  processQueue(serverId);
}

// ── Agent runners ─────────────────────────────────────
function spawnRunner(message, onChunk, bin, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';
    let resolved = false;

    function done() {
      if (resolved) return;
      resolved = true;
      try { proc.kill(); } catch (_) {}
      console.log('[agent] done, output length:', output.length);
      if (output) resolve(output);
      else if (error) resolve(`STDERR: ${error}`);
      else resolve('Agent completed with no output.');
    }

    const proc = spawn(bin, args, {
      cwd: WORK_DIR,
      env: AGENT_ENV,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (bin === 'agent') {
      proc.stdin.write(message + '\n');
      proc.stdin.end();
    } else {
      proc.stdin.end(); // claude gets message via args
    }

    proc.stdout.on('data', (data) => {
      output += data.toString();
      onChunk(output);
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', (code) => {
      console.log('[agent] process closed, code:', code);
      done();
    });

    proc.on('exit', (code) => {
      console.log('[agent] process exited, code:', code);
      done();
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });
  });
}

function runAgent(st, message, onChunk) {
  const args = ['--print', '--trust', '--yolo'];
  if (st.hasSession) args.push('--continue');
  return spawnRunner(message, onChunk, 'agent', args);
}

// `opencode run` is opencode's non-interactive mode: the prompt is a
// positional argument, `--continue` resumes the last session. Extra flags
// (e.g. `--model provider/model`) via OPENCODE_ARGS.
const OPENCODE_ARGS = (process.env.OPENCODE_ARGS || '').split(/\s+/).filter(Boolean);
function opencodeArgs(st) {
  return ['run', ...OPENCODE_ARGS, ...(st.hasSession ? ['--continue'] : [])];
}
function runOpencode(st, message, onChunk) {
  return spawnRunner(message, onChunk, 'opencode', [...opencodeArgs(st), message]);
}

const AGENT_LABELS = { agent: 'Cursor Agent', claude: 'Claude Code', opencode: 'opencode' };
const AGENT_TYPES = Object.keys(AGENT_LABELS);

function getClaudeUid() {
  try {
    const uid = parseInt(require('child_process').execSync(`id -u ${CLAUDE_USER}`).toString().trim(), 10);
    const gid = parseInt(require('child_process').execSync(`id -g ${CLAUDE_USER}`).toString().trim(), 10);
    return { uid, gid, home: `/home/${CLAUDE_USER}` };
  } catch {
    return null;
  }
}

function runClaudeCode(st, message, onChunk) {
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';

    const args = ['--print', '--dangerously-skip-permissions'];
    if (st.hasSession) args.push('--continue');
    args.push(message);

    // Only switch user if running as root and CLAUDE_USER is different
    const isRoot = process.getuid && process.getuid() === 0;
    const userInfo = isRoot ? getClaudeUid() : null;

    const spawnOpts = {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        ...(userInfo ? { HOME: userInfo.home, USER: CLAUDE_USER } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(userInfo ? { uid: userInfo.uid, gid: userInfo.gid } : {}),
    };

    const proc = spawn('claude', args, spawnOpts);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      output += data.toString();
      onChunk(output);
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', (code) => {
      console.log('[claude] closed, code:', code, 'stdout:', output.length, 'stderr:', error.length);
      if (output) resolve(output);
      else if (error) resolve(error);
      else resolve('Claude completed with no output.');
    });

    proc.on('error', (err) => {
      console.log('[claude] error:', err.message);
      reject(err);
    });
  });
}

// Remote agents run over SSH; the message travels base64-encoded via stdin
// so no shell-quoting of user text is ever needed.
function runRemoteAgent(serverId, st, message, onChunk) {
  const b64 = Buffer.from(message, 'utf8').toString('base64');
  const cont = st.hasSession ? ' --continue' : '';
  const cmd = st.agentType === 'claude'
    ? `${remote.AGENT_PATH}; echo ${b64} | base64 -d | claude --print --dangerously-skip-permissions${cont}`
    : st.agentType === 'opencode'
      // opencode takes the prompt as an argument, not on stdin; "$(...)"
      // keeps the decoded text as one argument with no shell quoting of it.
      ? `${remote.AGENT_PATH} opencode ${opencodeArgs(st).join(' ')} "$(echo ${b64} | base64 -d)"`
      : `${remote.AGENT_PATH}; echo ${b64} | base64 -d | agent --print --trust --yolo${cont}`;
  return remote.streamOnServer(serverId, cmd, onChunk);
}

function runActive(serverId, message, onChunk) {
  const st = chatState(serverId);
  if (serverId !== LOCAL_ID) return runRemoteAgent(serverId, st, message, onChunk);
  if (st.agentType === 'claude') return runClaudeCode(st, message, onChunk);
  if (st.agentType === 'opencode') return runOpencode(st, message, onChunk);
  return runAgent(st, message, onChunk);
}

async function runCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORK_DIR,
      env: AGENT_ENV,
      timeout: 30000
    });
    return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── Screen Session Management ─────────────────────────
// Local sessions attach via node-pty; remote ones via an SSH PTY channel.
// Both are wrapped in the same handle shape (write/resize/kill/onData/onExit).
const pty = require('node-pty');
const screenPtys = new Map(); // key: `${socketId}:${serverId}:${sessionName}` → { handle, sessionName, … }
const joinSeq = new Map();    // same key → latest join's sequence number; attach has two awaits a newer join can overtake

// Which backend owns a given (serverId, fullName). Populated from every list;
// attach/input/history/rename/resize resolve the backend from it, falling
// back to a shape-based guess (see muxer.guess) when the cache is cold.
const backendOf = new Map(); // serverId → Map(fullName → 'screen'|'tmux')
function rememberBackends(serverId, sessions) {
  let m = backendOf.get(serverId);
  if (!m) { m = new Map(); backendOf.set(serverId, m); }
  for (const s of sessions) m.set(s.fullName, s.backend);
}
function backendFor(serverId, fullName) {
  const m = backendOf.get(serverId);
  return muxer.byName(m && m.get(fullName)) || muxer.guess(fullName);
}
// tmux app sessions created by the ⚡ direct terminal live on the same socket;
// keep them out of the normal session list.
function isDirectAppSession(name) {
  return Object.keys(DIRECT_APPS).some((a) => name === `termi-${a}`);
}

async function runList(serverId, cmd, timeout) {
  if (serverId === LOCAL_ID) return (await execAsync(cmd, { timeout })).stdout;
  return (await remote.execOnServer(serverId, cmd, { timeout })).stdout;
}

// List sessions from BOTH backends and merge. screen sessions are detected and
// driven exactly as before; tmux sessions (new, truecolor) sit alongside them.
async function listScreenSessions(serverId = LOCAL_ID) {
  const sessions = [];
  const localTimeout = 5000, remoteTimeout = 10000;
  const t = serverId === LOCAL_ID ? localTimeout : remoteTimeout;
  try {
    sessions.push(...muxer.screen.parseList(await runList(serverId, muxer.screen.listCmd, t)));
  } catch (err) {
    if (err && err.stdout) sessions.push(...muxer.screen.parseList(err.stdout));
  }
  try {
    const tmuxSessions = muxer.tmux.parseList(await runList(serverId, muxer.tmux.listCmd, t));
    sessions.push(...tmuxSessions.filter((s) => !isDirectAppSession(s.name)));
  } catch (_) { /* tmux absent or no server running → no tmux sessions */ }
  rememberBackends(serverId, sessions);
  return annotateSessions(serverId, sessions);
}

// A watched session always has the hub's own watcher display attached, so
// `screen -ls` would call it "attached" forever. For those, report what the
// user cares about: is a termi client on it right now?
function clientAttached(serverId, pid, visibleOnly) {
  for (const entry of screenPtys.values()) {
    if (entry.serverId !== serverId || entry.sessionName.split('.')[0] !== String(pid)) continue;
    if (!visibleOnly || (entry.socket && entry.socket.data && entry.socket.data.visible !== false)) return true;
  }
  return false;
}
function annotateSessions(serverId, sessions) {
  for (const s of sessions) {
    if (watchers.has(notify.watchKey(serverId, s.pid))) {
      s.watched = true;
      s.status = clientAttached(serverId, s.pid) ? 'attached' : 'detached';
    }
  }
  return sessions;
}

function parseScreenLs(output) {
  const sessions = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\t(\d+)\.(\S+)\t(.+)$/);
    if (!match) continue;
    const pid = match[1];
    const name = match[2];
    // Trailing fields are parenthesized and the status is always the last one —
    // some systems prepend a timestamp: "(06/11/2026 02:42:42 PM)\t(Attached)"
    const fields = [...match[3].matchAll(/\(([^)]*)\)/g)];
    if (!fields.length) continue;
    const statusRaw = fields[fields.length - 1][1].toLowerCase();
    const attached = statusRaw.includes('attached');
    sessions.push({ pid, name, fullName: `${pid}.${name}`, status: attached ? 'attached' : 'detached' });
  }
  return sessions;
}

// Spawn a local pty from a backend spawn spec ({bin, args}). The backend's
// extraEnv carries anything the attach needs (tmux wants TERM/COLORTERM so it
// advertises truecolor to the program inside).
function spawnLocalMux(spec, cols, rows, backend) {
  const term = pty.spawn(spec.bin, spec.args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.HOME,
    env: { ...process.env, ...((backend && backend.extraEnv) || {}) },
  });
  return {
    write: (d) => term.write(d),
    resize: (c, r) => { try { term.resize(c, r); } catch (_) {} },
    kill: () => { try { term.kill(); } catch (_) {} },
    onData: (fn) => term.onData(fn),
    onExit: (fn) => term.onExit(fn),
  };
}

// A browser attach. screen uses `screen -A -x` (-A adapts the shared window to
// THIS display); tmux runs its attach script (truecolor + `window-size latest`,
// which follows the attached pty). Remote attaches run the same command over SSH.
function openLocalPty(backend, fullName, cols, rows) {
  return spawnLocalMux(backend.attachSpawn(fullName), cols, rows, backend);
}
function attachRemoteCmd(backend, fullName) {
  const cmd = backend.attachRemoteCmd(fullName);
  return backend.needsAgentPath ? `${remote.AGENT_PATH}; ${cmd}` : cmd;
}

// Run the client-bound byte stream through the alt-screen filter so
// xterm.js keeps native scrollback (see lib/termfilter.js).
function filterHandle(handle) {
  const filter = altScreenFilter();
  return {
    ...handle,
    onData: (fn) => handle.onData((d) => { const out = filter(d); if (out) fn(out); }),
  };
}

// Run a screen command inside a session from outside (`screen -S x -X …`).
function screenCmd(serverId, cmd) {
  return serverId === LOCAL_ID
    ? execAsync(cmd, { timeout: 5000 })
    : remote.execOnServer(serverId, cmd, { timeout: 10000 });
}

// screen's default history is 100 lines — useless for reading what an
// agent did while you were away. Raise it once per session (per hub run).
const SCROLLBACK_LINES = parseInt(process.env.SCREEN_SCROLLBACK || '10000', 10);
const scrollbackBumped = new Set();
function bumpScrollback(serverId, sessionName) {
  const backend = backendFor(serverId, sessionName);
  const key = `${serverId}:${backend.name}:${sessionName.split('.')[0]}`;
  if (scrollbackBumped.has(key)) return;
  scrollbackBumped.add(key);
  screenCmd(serverId, backend.scrollbackCmd(sessionName, SCROLLBACK_LINES)).catch((err) => { scrollbackBumped.delete(key); console.log('[screen] scrollback bump failed:', serverId, sessionName, err.message); });
}

// The window's scrollback + screen as plain text (`hardcopy -h`), for the
// history sheet: scroll, select, copy — even what happened while away.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function screenHistory(serverId, sessionName) {
  if (!SAFE_SESSION.test(sessionName)) throw new Error('Invalid session name');
  const backend = backendFor(serverId, sessionName);

  // tmux prints the scrollback straight to stdout (`capture-pane -p`) — no
  // tmp file, no settle delay.
  if (backend.historyMode === 'stdout') {
    const cmd = backend.historyCmd(sessionName, { lines: SCROLLBACK_LINES });
    if (serverId === LOCAL_ID) {
      const { stdout } = await execAsync(cmd, { timeout: 8000 });
      return cleanHardcopy(stdout);
    }
    const { stdout, stderr, code } = await remote.execOnServer(serverId, cmd, { timeout: 20000 });
    if (code !== 0 && !stdout) throw new Error((stderr || 'capture-pane failed').trim().split('\n')[0]);
    return cleanHardcopy(stdout);
  }

  // screen writes the window + scrollback to a file (`hardcopy -h`).
  const tmp = `/tmp/termi-hc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (serverId === LOCAL_ID) {
    await execAsync(backend.historyCmd(sessionName, { tmp }), { timeout: 5000 });
    // hardcopy is written by the session process right after the message
    // lands; give it a moment (and one more on a slow box).
    let text = null;
    for (let i = 0; i < 4 && text === null; i++) {
      await sleep(i === 0 ? 250 : 400);
      try { text = fs.readFileSync(tmp, 'utf8'); } catch (_) { text = null; }
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (text === null) throw new Error('screen did not write the history file');
    return cleanHardcopy(text);
  }
  const { stdout, stderr, code } = await remote.execOnServer(serverId,
    `${backend.historyCmd(sessionName, { tmp })} && sleep 0.4 && cat ${tmp}; s=$?; rm -f ${tmp}; exit $s`, { timeout: 20000 });
  if (code !== 0 && !stdout) throw new Error((stderr || 'hardcopy failed').trim().split('\n')[0]);
  return cleanHardcopy(stdout);
}

async function attachScreen(socket, serverId, sessionName, cols, rows) {
  if (!SAFE_SESSION.test(sessionName)) {
    socket.emit('screen:exit', { serverId, sessionName, exitCode: -1, error: 'Invalid session name' });
    return;
  }
  const key = `${socket.id}:${serverId}:${sessionName}`;
  detachScreen(socket, serverId, sessionName);

  const backend = backendFor(serverId, sessionName);
  console.log('[screen] attaching:', serverId, sessionName, `${cols}x${rows}`, `(${backend.name})`);

  // Size the window BEFORE the display attaches (see setWindowSize for why
  // -A is not enough). Order matters: a `width` that lands while the
  // display is still attaching leaves screen's picture of that display
  // misaligned — the frame comes out scrolled up by a third of the screen
  // until the next resize — whereas a display attaching to a window that
  // already has its size gets a clean, correct redraw.
  const seq = (joinSeq.get(key) || 0) + 1;
  joinSeq.set(key, seq);
  const sized = await applyWindowSize(serverId, sessionName, cols, rows);
  if (joinSeq.get(key) !== seq) return;   // a newer join for this pane superseded us
  detachScreen(socket, serverId, sessionName);   // …and whatever attached meanwhile

  let handle;
  try {
    handle = filterHandle(serverId === LOCAL_ID
      ? openLocalPty(backend, sessionName, cols, rows)
      : await remote.openRemotePty(serverId, attachRemoteCmd(backend, sessionName), { cols: cols || 80, rows: rows || 24 }));
  } catch (err) {
    console.log('[screen] attach failed:', serverId, sessionName, err.message);
    socket.emit('screen:exit', { serverId, sessionName, exitCode: -1, error: err.message });
    return;
  }
  if (joinSeq.get(key) !== seq) { try { handle.kill(); } catch (_) {} return; }

  handle.onData((data) => {
    socket.emit('screen:output', { serverId, sessionName, data });
  });

  handle.onExit(({ exitCode }) => {
    console.log('[screen] pty exited:', serverId, sessionName, 'code:', exitCode);
    // Only the currently registered pty speaks for the session — exits from
    // ptys we already replaced (re-attach) or detached must not reach the
    // client as "session ended".
    const cur = screenPtys.get(key);
    if (cur && cur.handle !== handle) return;
    screenPtys.delete(key);
    socket.emit('screen:exit', { serverId, sessionName, exitCode });
  });

  const size = { cols, rows };
  screenPtys.set(key, { handle, sessionName, serverId, socket, backend, wantSize: size, appliedSize: sized ? size : null, sizeTimer: null, sizing: false, sizeDirty: false, closed: false });
  bumpScrollback(serverId, sessionName);
}

// ── Window size ────────────────────────────────────────
// `-A` only adapts the window while it is shown on a single display; with
// the hub's notification watcher attached (see openWatchPty), a laptop, or
// a previous termi attach still winding down, it silently does nothing and
// the phone gets a 48-column slice of a 200-column window — a full-screen
// app like opencode looks shredded. So the window size is also set
// explicitly, with `width -w` (see lib/screenctl.js): right before the
// display attaches (attachScreen) and after every client resize — there
// the display's own pty is resized first, then the window is brought to
// the same size, which screen redraws cleanly. Resizes are settled briefly:
// a phone fires several per keyboard open/close, and on a remote box each
// one is an SSH exec.
const RESIZE_SETTLE_MS = 200;
async function applyWindowSize(serverId, sessionName, cols, rows) {
  const backend = backendFor(serverId, sessionName);
  // tmux tracks the attached pty's size (`window-size latest`); resizing the
  // display pty is enough, no external command needed.
  if (!backend.externalSize) return true;
  const cmd = backend.windowSizeCmd(sessionName, cols, rows);
  if (!cmd) return false;
  try { await screenCmd(serverId, cmd); return true; }
  catch (err) { console.log('[screen] window size failed:', serverId, sessionName, err.message); return false; }
}
function setWindowSize(entry, cols, rows) {
  entry.wantSize = { cols, rows };
  if (entry.sizeTimer) return;
  entry.sizeTimer = setTimeout(() => { entry.sizeTimer = null; flushWindowSize(entry); }, RESIZE_SETTLE_MS);
}
async function flushWindowSize(entry) {
  if (entry.closed) return;
  if (entry.sizing) { entry.sizeDirty = true; return; }
  const want = entry.wantSize;
  if (!want || (entry.appliedSize && entry.appliedSize.cols === want.cols && entry.appliedSize.rows === want.rows)) return;
  entry.sizing = true;
  if (await applyWindowSize(entry.serverId, entry.sessionName, want.cols, want.rows)) entry.appliedSize = want;
  entry.sizing = false;
  if (entry.sizeDirty) { entry.sizeDirty = false; flushWindowSize(entry); }
}

function detachScreen(socket, serverId, sessionName) {
  const key = `${socket.id}:${serverId}:${sessionName}`;
  const entry = screenPtys.get(key);
  if (entry) {
    entry.closed = true; clearTimeout(entry.sizeTimer);
    // Detach cleanly without killing the session. screen needs Ctrl-A d;
    // tmux keeps the session in its daemon when the client pty is killed,
    // so it has no detach key.
    const keys = entry.backend && entry.backend.detachKeys;
    if (keys) entry.handle.write(keys);
    setTimeout(() => {
      try { entry.handle.kill(); } catch (_) {}
    }, keys ? 500 : 0);
    screenPtys.delete(key);
  }
}

function detachAllScreens(socketId) {
  for (const key of joinSeq.keys()) if (key.startsWith(`${socketId}:`)) joinSeq.delete(key);
  for (const [key, entry] of screenPtys.entries()) {
    if (key.startsWith(`${socketId}:`)) {
      entry.closed = true; clearTimeout(entry.sizeTimer);
      const keys = entry.backend && entry.backend.detachKeys;
      if (keys) entry.handle.write(keys);
      setTimeout(() => {
        try { entry.handle.kill(); } catch (_) {}
      }, keys ? 500 : 0);
      screenPtys.delete(key);
    }
  }
}

function sendScreenInput(socket, serverId, sessionName, data) {
  const entry = screenPtys.get(`${socket.id}:${serverId}:${sessionName}`);
  if (entry) {
    entry.handle.write(data);
    return true;
  }
  return false;
}

function resizeScreenPty(socket, serverId, sessionName, cols, rows) {
  const entry = screenPtys.get(`${socket.id}:${serverId}:${sessionName}`);
  if (!entry) return;
  entry.handle.resize(cols, rows);
  setWindowSize(entry, cols, rows);
}

// ── Session watchers → notifications ──────────────────
// A watched session keeps a hub-side display attached (`screen -x <pid>`,
// never resized, never -A; the user's own attach sets the window size
// explicitly, see setWindowSize, so this display can't fight it). Its
// output drives an IdleDetector; when a run goes quiet the user gets a push.
const watchers = new Map(); // watchKey → { entry, handle, detector, retry, fails, stopped, lastNotified }
const WATCH_COLS = 200, WATCH_ROWS = 50;
const NOTIFY_IDLE_MS = parseInt(process.env.NOTIFY_IDLE_MS || '5000', 10);
const NOTIFY_COOLDOWN_MS = 10000;

// The backend of a watched session: taken from the persisted entry when
// present (new watches store it), else inferred from the id/name shape so
// pre-existing (screen) watches keep working after an upgrade.
function watchBackend(entry) {
  return muxer.byName(entry.backend) || muxer.guess(entry.fullName || entry.pid);
}
// The session's full name (for the notification deep-link): stored on new
// watches; reconstructed as "<pid>.<name>" for older screen-only watches.
function watchFullName(entry) {
  return entry.fullName || `${entry.pid}.${entry.name}`;
}

function openWatchPty(entry) {
  const backend = watchBackend(entry);
  const id = entry.pid;
  if (entry.serverId === LOCAL_ID) {
    return Promise.resolve(spawnLocalMux(backend.watchSpawn(id), WATCH_COLS, WATCH_ROWS, backend));
  }
  const cmd = backend.needsAgentPath
    ? `${remote.AGENT_PATH}; ${backend.watchRemoteCmd(id)}`
    : backend.watchRemoteCmd(id);
  return remote.openRemotePty(entry.serverId, cmd, { cols: WATCH_COLS, rows: WATCH_ROWS });
}

async function startWatcher(entry) {
  const key = notify.watchKey(entry.serverId, entry.pid);
  let w = watchers.get(key);
  if (w && (w.handle || w.starting)) return;
  if (!w) { w = { entry, handle: null, detector: null, retry: null, fails: 0, stopped: false, lastNotified: 0 }; watchers.set(key, w); }
  w.entry = entry; w.starting = true;
  let handle;
  try { handle = await openWatchPty(entry); }
  catch (err) { w.starting = false; scheduleWatchRetry(w, err); return; }
  w.starting = false;
  if (w.stopped) { try { handle.kill(); } catch (_) {} return; }
  w.handle = handle;
  const det = new notify.IdleDetector({ idleMs: NOTIFY_IDLE_MS, onIdle: (info) => onSessionIdle(w, info) });
  w.detector = det;
  handle.onData((d) => det.feed(d));
  handle.onExit(async () => {
    det.dispose();
    if (w.handle !== handle) return;
    w.handle = null; w.detector = null;
    if (w.stopped) return;
    // Kicked off (someone ran `screen -d`) or the session died. Reattach if
    // it still exists, otherwise forget it.
    let alive = false;
    try { alive = (await listScreenSessions(entry.serverId)).some(s => String(s.id) === String(entry.pid)); } catch (_) {}
    if (alive) scheduleWatchRetry(w, null);
    else { console.log('[watch] session gone:', key); setWatch(entry.serverId, entry.pid, entry.name, false); }
  });
  w.fails = 0;
  console.log('[watch] attached:', key, entry.name);
}

function scheduleWatchRetry(w, err) {
  if (w.stopped) return;
  w.fails++;
  const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(w.fails, 6) - 1));
  if (err) console.log('[watch] attach failed:', notify.watchKey(w.entry.serverId, w.entry.pid), err.message, '— retry in', delay, 'ms');
  clearTimeout(w.retry);
  w.retry = setTimeout(() => startWatcher(w.entry), delay);
  if (w.retry.unref) w.retry.unref();
}

function stopWatcher(key) {
  const w = watchers.get(key);
  if (!w) return;
  w.stopped = true;
  clearTimeout(w.retry);
  if (w.detector) w.detector.dispose();
  const h = w.handle; w.handle = null;
  if (h) {
    const keys = watchBackend(w.entry).detachKeys;
    if (keys) { try { h.write(keys); } catch (_) {} }
    setTimeout(() => { try { h.kill(); } catch (_) {} }, keys ? 500 : 0);
  }
  watchers.delete(key);
}

function setWatch(serverId, pid, name, on, extra = {}) {
  pid = String(pid);
  if (on) {
    const entry = { serverId, pid, name: String(name || pid) };
    if (extra.fullName) entry.fullName = String(extra.fullName);
    if (extra.backend) entry.backend = String(extra.backend);
    notify.addWatch(entry);
    startWatcher(entry);
  } else {
    notify.removeWatch(serverId, pid);
    stopWatcher(notify.watchKey(serverId, pid));
  }
  io.emit('watch:list', { watches: notify.listWatches() });
}

// tmux's session name IS its identity, so renaming a watched tmux session
// moves its watch key. The live watcher handle stays attached (same session),
// we just re-file it under the new id. (screen keeps its pid across rename, so
// it needs none of this — see the rename handler.)
function rekeyWatch(serverId, oldId, newId) {
  const persisted = notify.listWatches().find(e => e.serverId === serverId && e.pid === oldId);
  const w = watchers.get(notify.watchKey(serverId, oldId));
  if (!persisted && !w) return;
  notify.removeWatch(serverId, oldId);
  notify.addWatch({ serverId, pid: newId, name: newId, fullName: newId, backend: 'tmux' });
  if (w) {
    watchers.delete(notify.watchKey(serverId, oldId));
    w.entry = { serverId, pid: newId, name: newId, fullName: newId, backend: 'tmux' };
    watchers.set(notify.watchKey(serverId, newId), w);
  }
  io.emit('watch:list', { watches: notify.listWatches() });
}

function startWatchers() {
  for (const entry of notify.listWatches()) startWatcher(entry);
}

function serverName(serverId) {
  if (serverId === LOCAL_ID) return os.hostname();
  const s = registry.listServers().find(x => x.id === serverId);
  return s ? s.name : serverId;
}

async function onSessionIdle(w, info) {
  const { serverId, pid, name } = w.entry;
  // Someone is looking at it in termi right now — nothing to announce.
  if (clientAttached(serverId, pid, true)) return;
  const now = Date.now();
  if (now - w.lastNotified < NOTIFY_COOLDOWN_MS) return;
  w.lastNotified = now;
  const fullName = watchFullName(w.entry);
  const payload = {
    title: `${name} · ${serverName(serverId)}`,
    body: (info.needsInput ? 'waiting for your input' : 'finished — waiting for you') + (info.snippet ? `\n${info.snippet}` : ''),
    url: `/#/srv/${encodeURIComponent(serverId)}/screen/${encodeURIComponent(fullName)}`,
    tag: `termi-${serverId}-${pid}`,
    ts: now,
  };
  console.log('[watch] idle:', serverId, fullName, info.needsInput ? 'needs input' : 'done', `(${info.runMs}ms, ${info.bytes}B)`);
  let res = { sent: 0 };
  try { res = await notify.sendPush(payload); } catch (err) { console.log('[push] error:', err.message); }
  io.emit('notify', { ...payload, serverId, sessionName: fullName, needsInput: !!info.needsInput, pushed: res.sent > 0 });
}

// ── Metrics (analytics page) ──────────────────────────
// One /proc-based command, no awk, so quoting stays trivial over SSH.
const METRICS_CMD = [
  'echo "===LOADAVG==="; cat /proc/loadavg 2>/dev/null',
  'echo "===NPROC==="; nproc 2>/dev/null',
  'echo "===MEMINFO==="; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo 2>/dev/null',
  'echo "===DF==="; df -Pk / 2>/dev/null',
  'echo "===UPTIME==="; cat /proc/uptime 2>/dev/null',
].join('; ');

function parseMetrics(out) {
  const sec = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^===(\w+)===$/);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur) sec[cur].push(line);
  }
  const load = ((sec.LOADAVG || [])[0] || '').trim().split(/\s+/).slice(0, 3).map(Number);
  const cpus = parseInt((sec.NPROC || [])[0], 10) || 1;
  let memTotal = 0, memAvail = 0;
  for (const l of sec.MEMINFO || []) {
    const mm = l.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
    if (mm) { if (mm[1] === 'MemTotal') memTotal = +mm[2]; else memAvail = +mm[2]; }
  }
  const df = (((sec.DF || [])[1]) || '').trim().split(/\s+/); // fs 1k-blocks used avail cap mount
  const diskTotal = +df[1] || 0, diskUsed = +df[2] || 0;
  const uptimeSec = Math.floor(parseFloat(((sec.UPTIME || [])[0] || '0').split(/\s+/)[0]) || 0);
  return {
    load, cpus,
    loadPct: cpus ? Math.min(100, Math.round((load[0] / cpus) * 100)) : null,
    memTotalKb: memTotal, memUsedKb: Math.max(0, memTotal - memAvail),
    memPct: memTotal ? Math.round((1 - memAvail / memTotal) * 100) : null,
    diskTotalKb: diskTotal, diskUsedKb: diskUsed,
    diskPct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : null,
    uptimeSec,
  };
}

const metricsCache = new Map();
async function gatherMetrics(serverId) {
  const c = metricsCache.get(serverId);
  if (c && Date.now() - c.t < 15000) return c.m;
  let m = null;
  try {
    const out = serverId === LOCAL_ID
      ? (await execAsync(METRICS_CMD, { timeout: 8000, shell: '/bin/bash' })).stdout
      : (await remote.execOnServer(serverId, METRICS_CMD, { timeout: 12000 })).stdout;
    m = parseMetrics(out);
  } catch (_) { m = null; }
  metricsCache.set(serverId, { t: Date.now(), m });
  return m;
}

// ── Server probing (dashboard status dots) ────────────
const probeCache = new Map(); // serverId → { t, result }
const PROBE_TTL = 20000;

async function probeAndEmit(serverId, force) {
  const cached = probeCache.get(serverId);
  if (!force && cached && Date.now() - cached.t < PROBE_TTL) {
    io.emit('servers:status', { id: serverId, ...cached.result });
    return cached.result;
  }
  let result;
  if (serverId === LOCAL_ID) {
    const sessions = await listScreenSessions(LOCAL_ID);
    const [agentAvail, claudeAvail, opencodeAvail, tmuxAvail] = await Promise.all([
      execAsync('which agent', { env: AGENT_ENV }).then(() => true).catch(() => false),
      execAsync('which claude', { env: AGENT_ENV }).then(() => true).catch(() => false),
      execAsync('which opencode', { env: AGENT_ENV }).then(() => true).catch(() => false),
      execAsync('which tmux', { env: AGENT_ENV }).then(() => true).catch(() => false),
    ]);
    result = {
      online: true, hasScreen: true, hasTmux: tmuxAvail, hasClaude: claudeAvail, hasAgent: agentAvail, hasOpencode: opencodeAvail,
      screens: sessions.length, attached: sessions.filter(s => s.status === 'attached').length,
      sessions: sessions.slice(0, 16),
    };
  } else {
    const probe = await remote.probeServer(serverId);
    const sessions = annotateSessions(serverId, [
      ...muxer.screen.parseList(probe.screenLs || ''),
      ...muxer.tmux.parseList(probe.tmuxLs || '').filter(s => !isDirectAppSession(s.name)),
    ]);
    rememberBackends(serverId, sessions);
    result = {
      online: probe.online,
      hasScreen: !!probe.hasScreen,
      hasTmux: !!probe.hasTmux,
      hasClaude: !!probe.hasClaude,
      hasAgent: !!probe.hasAgent,
      hasOpencode: !!probe.hasOpencode,
      screens: sessions.length,
      attached: sessions.filter(s => s.status === 'attached').length,
      sessions: sessions.slice(0, 16),
      error: probe.error,
    };
  }
  probeCache.set(serverId, { t: Date.now(), result });
  io.emit('servers:status', { id: serverId, ...result });
  return result;
}

function serverListPayload() {
  return {
    servers: [
      { id: LOCAL_ID, name: 'this server', host: os.hostname(), port: null, user: null, local: true },
      ...registry.listServers(),
    ],
    keys: registry.listKeys(),
  };
}

// ── Socket ────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token !== AUTH_TOKEN) return next(new Error('Unauthorized'));
  next();
});

// ── Direct terminal (tmux-backed) ──────────────────────
// A faithful, full-fidelity terminal that is ALSO persistent. The app runs
// inside a tmux session (one per app, `termi-<app>`); termi attaches to it
// and streams the bytes straight to xterm.js. Unlike GNU screen 4.x — which
// downconverts opencode's 24-bit color to a dim approximation, the reason it
// looks washed out through a normal attach — tmux carries truecolor, the
// alternate screen and mouse through intact. And because the session lives
// in the tmux server (a daemon), it keeps running when the browser closes or
// the socket drops: reopening the app re-attaches to the same live session,
// exactly like the screen sessions termi is built around. tmux must be
// installed on the target box (it usually is; the terminal says so if not).
//
// Only apps on this allowlist can be launched — the client sends an id, not
// a command line, so nothing arbitrary is ever run. Add more with
// TERMI_DIRECT_APPS=lazygit,btop (each taken as its own bare command).
const DIRECT_APPS = { opencode: { bin: 'opencode', args: OPENCODE_ARGS } };
for (const name of (process.env.TERMI_DIRECT_APPS || '').split(',').map(x => x.trim()).filter(Boolean)) {
  if (/^[\w.-]+$/.test(name) && !DIRECT_APPS[name]) DIRECT_APPS[name] = { bin: name, args: [] };
}
const directPtys = new Map(); // `${socket.id}:${termId}` → handle

// Dedicated tmux server socket, kept separate from any tmux the user runs.
const TMUX = 'tmux -L termi';
// Shell that creates the app's tmux session if absent, forces truecolor, and
// attaches (exec, so a dropped connection cleanly detaches and the session
// keeps running in the tmux daemon). Idempotent: a second call re-attaches.
function tmuxAttachScript(app, appId, cols, rows) {
  const session = `termi-${appId}`;
  const inner = `COLORTERM=truecolor ${[app.bin, ...app.args].map(remote.shq).join(' ')}`;
  const opts = `${TMUX} set -g default-terminal tmux-256color \\; set -ga terminal-overrides ',*:Tc' \\; `
    + `set -g status off \\; set -g window-size latest \\; set -g escape-time 10 \\; set -g destroy-unattached off`;
  return [
    `command -v tmux >/dev/null 2>&1 || { printf '\\r\\n  tmux is not installed on this server.\\r\\n  The persistent terminal needs it (apt install tmux).\\r\\n'; sleep 3; exit 127; }`,
    `${TMUX} new-session -d -s ${remote.shq(session)} -x ${cols || 80} -y ${rows || 24} ${remote.shq(inner)} 2>/dev/null`,
    `${opts} >/dev/null 2>&1`,
    `exec ${TMUX} attach -t ${remote.shq(session)}`,
  ].join('; ');
}

function openDirectLocal(app, appId, cols, rows) {
  const term = pty.spawn('bash', ['-lc', tmuxAttachScript(app, appId, cols, rows)], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: WORK_DIR,
    env: { ...AGENT_ENV, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  return {
    write: (d) => { try { term.write(d); } catch (_) {} },
    resize: (c, r) => { try { term.resize(c, r); } catch (_) {} },
    kill: () => { try { term.kill(); } catch (_) {} },
    onData: (fn) => term.onData(fn),
    onExit: (fn) => term.onExit(fn),
  };
}

function openDirectRemote(serverId, app, appId, cols, rows) {
  const cmd = `${remote.AGENT_PATH}; ${tmuxAttachScript(app, appId, cols, rows)}`;
  return remote.openRemotePty(serverId, cmd, { cols: cols || 80, rows: rows || 24 });
}

async function openDirectTerm(socket, termId, serverId, appId, cols, rows) {
  const app = DIRECT_APPS[appId];
  const key = `${socket.id}:${termId}`;
  if (!app) { socket.emit('term:exit', { termId, error: `Unknown app: ${appId}` }); return; }
  if (directPtys.has(key)) closeDirectTerm(socket, termId);
  console.log('[direct] open:', serverId, appId, `${cols}x${rows}`);
  let handle;
  try {
    handle = serverId === LOCAL_ID
      ? openDirectLocal(app, appId, cols, rows)
      : await openDirectRemote(serverId, app, appId, cols, rows);
  } catch (err) {
    console.log('[direct] open failed:', serverId, appId, err.message);
    socket.emit('term:exit', { termId, error: err.message });
    return;
  }
  directPtys.set(key, handle);
  handle.onData((d) => socket.emit('term:data', { termId, data: typeof d === 'string' ? d : d.toString('utf8') }));
  handle.onExit((ev) => {
    if (directPtys.get(key) !== handle) return;
    directPtys.delete(key);
    socket.emit('term:exit', { termId, exitCode: ev && ev.exitCode });
  });
}

function closeDirectTerm(socket, termId) {
  const key = `${socket.id}:${termId}`;
  const handle = directPtys.get(key);
  if (!handle) return;
  directPtys.delete(key);
  try { handle.kill(); } catch (_) {}
}

function closeAllDirect(socketId) {
  for (const [key, handle] of directPtys.entries()) {
    if (!key.startsWith(`${socketId}:`)) continue;
    directPtys.delete(key);
    try { handle.kill(); } catch (_) {}
  }
}

io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id, 'transport:', socket.conn.transport.name);
  socket.data.visible = true;
  socket.emit('watch:list', { watches: notify.listWatches() });

  // Page visibility, so an idle notification isn't pushed to a phone that
  // is looking at the session already.
  socket.on('client:visible', (p) => { socket.data.visible = !(p && p.visible === false); });

  socket.on('init', async (payload) => {
    const serverId = (payload && payload.serverId) || LOCAL_ID;
    const st = chatState(serverId);

    let agentAvail = false, claudeAvail = false, opencodeAvail = false, online = true;
    try {
      const probe = await probeAndEmit(serverId);
      agentAvail = !!probe.hasAgent;
      claudeAvail = !!probe.hasClaude;
      opencodeAvail = !!probe.hasOpencode;
      online = !!probe.online;
    } catch (_) {}
    const avail = { agent: agentAvail, claude: claudeAvail, opencode: opencodeAvail };

    if (!online) {
      socket.emit('status', { serverId, connected: false, message: 'Server unreachable over SSH.' });
      return;
    }
    if (!agentAvail && !claudeAvail && !opencodeAvail) {
      socket.emit('status', { serverId, connected: true, agentType: st.agentType, agentAvail, claudeAvail, opencodeAvail, message: 'No agent CLI found on this server.' });
      return;
    }

    // If current agentType isn't available, fall back to what is
    if (!avail[st.agentType]) st.agentType = AGENT_TYPES.find(t => avail[t]);

    // If agent is currently running — send current output so mobile catches up
    if (st.agentRunning && st.pendingOutput) {
      socket.emit('response', { serverId, type: 'thinking', content: st.pendingOutput });
    }

    // If we have a completed response the client may have missed — resend it
    if (st.lastResponse && !st.agentRunning) {
      console.log('[init] resending lastResponse to', socket.id, 'for', serverId);
      socket.emit('response', st.lastResponse);
    }

    socket.emit('queue', { serverId, queue: st.queue });

    socket.emit('status', {
      serverId,
      connected: true,
      agentType: st.agentType,
      agentAvail,
      claudeAvail,
      opencodeAvail,
      message: st.agentRunning
        ? 'Agent is busy — reconnected, catching up...'
        : st.hasSession
          ? 'Reconnected — session context intact'
          : serverId === LOCAL_ID ? `Ready — ${WORK_DIR}` : 'Ready'
    });
  });

  socket.on('setAgent', ({ type, serverId = LOCAL_ID }) => {
    if (!AGENT_TYPES.includes(type)) return;
    const st = chatState(serverId);
    if (st.agentRunning) {
      socket.emit('response', { serverId, type: 'error', content: 'Cannot switch agents while one is running.' });
      return;
    }
    st.agentType = type;
    st.hasSession = false;
    st.lastResponse = null;
    st.pendingOutput = '';
    socket.emit('agentSwitched', { serverId, agentType: st.agentType });
    socket.emit('response', { serverId, type: 'system', content: `Switched to ${AGENT_LABELS[type]} — session reset.` });
  });

  socket.on('chat', ({ message, serverId = LOCAL_ID }) => {
    const st = chatState(serverId);
    st.queue.push({ id: Date.now(), message });
    emitQueue(serverId);
    processQueue(serverId);
  });

  socket.on('queue:remove', ({ id, serverId = LOCAL_ID }) => {
    const st = chatState(serverId);
    st.queue = st.queue.filter(i => i.id !== id);
    emitQueue(serverId);
  });

  socket.on('queue:move', ({ id, direction, serverId = LOCAL_ID }) => {
    const q = chatState(serverId).queue;
    const idx = q.findIndex(i => i.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx > 0) {
      [q[idx - 1], q[idx]] = [q[idx], q[idx - 1]];
    }
    if (direction === 'down' && idx < q.length - 1) {
      [q[idx], q[idx + 1]] = [q[idx + 1], q[idx]];
    }
    emitQueue(serverId);
  });

  socket.on('queue:clear', ({ serverId = LOCAL_ID } = {}) => {
    chatState(serverId).queue = [];
    emitQueue(serverId);
  });

  socket.on('reset', ({ serverId = LOCAL_ID } = {}) => {
    const st = chatState(serverId);
    if (st.agentRunning) {
      socket.emit('response', { serverId, type: 'error', content: 'Agent is busy. Wait for it to finish first.' });
      return;
    }
    st.hasSession = false;
    st.lastResponse = null;
    st.pendingOutput = '';
    st.queue = [];
    emitQueue(serverId);
    socket.emit('response', { serverId, type: 'system', content: 'Session reset — starting fresh.' });
  });

  // ── Screen session events ──────────────────────────
  socket.on('screen:list', async (payload) => {
    const serverId = (payload && payload.serverId) || LOCAL_ID;
    const sessions = await listScreenSessions(serverId);
    socket.emit('screen:list', { serverId, sessions });
  });

  // Create a detached screen session (used to auto-provision a default
  // terminal when a server has none).
  socket.on('screen:create', async ({ serverId = LOCAL_ID, name }) => {
    const clean = String(name || 'terminal').replace(/[^\w.\-]/g, '-').slice(0, 40);
    if (!SAFE_SESSION.test(clean) || isDirectAppSession(clean)) return;
    // New sessions default to tmux (truecolor); fall back to screen where tmux
    // is absent. Probe is cached, so this is cheap.
    const probe = (probeCache.get(serverId) || {}).result || await probeAndEmit(serverId);
    const backend = muxer.pickCreateBackend(probe);
    console.log('[screen] create:', serverId, clean, `(${backend.name})`);
    try {
      const cmd = backend.createCmd(clean, { scrollback: SCROLLBACK_LINES });
      if (serverId === LOCAL_ID) await execAsync(cmd, { timeout: 8000, cwd: WORK_DIR });
      else await remote.execOnServer(serverId, cmd, { timeout: 12000 });
      probeCache.delete(serverId);
      const sessions = await listScreenSessions(serverId);
      socket.emit('screen:list', { serverId, sessions });
    } catch (err) {
      socket.emit('servers:error', { message: 'Could not create session: ' + err.message });
    }
  });

  // Rename a session in place (screen keeps the pid, so the new fullName
  // is derivable). Broadcast so every client can remap open panes/URLs.
  socket.on('screen:rename', async ({ serverId = LOCAL_ID, sessionName, newName }) => {
    const clean = String(newName || '').replace(/[^\w.\-]/g, '-').slice(0, 40);
    if (!SAFE_SESSION.test(sessionName) || !clean || !SAFE_SESSION.test(clean)) return;
    if (isDirectAppSession(clean)) return;
    const backend = backendFor(serverId, sessionName);
    console.log('[screen] rename:', serverId, sessionName, '→', clean, `(${backend.name})`);
    try {
      const cmd = backend.renameCmd(sessionName, clean);
      if (serverId === LOCAL_ID) await execAsync(cmd, { timeout: 5000 });
      else await remote.execOnServer(serverId, cmd, { timeout: 12000 });
      probeCache.delete(serverId);
      let newFullName;
      if (backend.name === 'screen') {
        // The pid (identity) survives a screen rename; only the name changes.
        const pid = sessionName.split('.')[0];
        notify.renameWatch(serverId, pid, clean);
        const w = watchers.get(notify.watchKey(serverId, pid));
        if (w) w.entry.name = clean;
        newFullName = `${pid}.${clean}`;
      } else {
        // tmux: the name is the identity, so the watch key moves with it.
        rekeyWatch(serverId, sessionName, clean);
        newFullName = clean;
      }
      io.emit('screen:renamed', { serverId, oldFullName: sessionName, newFullName });
      const sessions = await listScreenSessions(serverId);
      io.emit('screen:list', { serverId, sessions });
    } catch (err) {
      socket.emit('servers:error', { message: 'Rename failed: ' + err.message });
    }
  });

  socket.on('screen:join', ({ sessionName, cols, rows, serverId = LOCAL_ID }) => {
    console.log('[screen] join:', serverId, sessionName, `${cols}x${rows}`);
    attachScreen(socket, serverId, sessionName, cols, rows);
  });

  socket.on('screen:leave', ({ sessionName, serverId = LOCAL_ID }) => {
    console.log('[screen] leave:', serverId, sessionName);
    detachScreen(socket, serverId, sessionName);
  });

  // ── Direct terminal events (see openDirectTerm) ──────
  socket.on('term:open', ({ termId, serverId = LOCAL_ID, app, cols, rows }) => {
    openDirectTerm(socket, String(termId || '1'), serverId, String(app || ''), cols, rows);
  });
  socket.on('term:input', ({ termId, data }) => {
    const h = directPtys.get(`${socket.id}:${termId}`);
    if (h && typeof data === 'string') h.write(data);
  });
  socket.on('term:resize', ({ termId, cols, rows }) => {
    const h = directPtys.get(`${socket.id}:${termId}`);
    if (h) h.resize(cols, rows);
  });
  socket.on('term:close', ({ termId }) => closeDirectTerm(socket, String(termId || '1')));

  socket.on('screen:input', ({ sessionName, data, serverId = LOCAL_ID }) => {
    sendScreenInput(socket, serverId, sessionName, data);
  });

  socket.on('screen:resize', ({ sessionName, cols, rows, serverId = LOCAL_ID }) => {
    resizeScreenPty(socket, serverId, sessionName, cols, rows);
  });

  socket.on('screen:history', async ({ sessionName, serverId = LOCAL_ID }) => {
    try {
      const text = await screenHistory(serverId, String(sessionName || ''));
      socket.emit('screen:history', { serverId, sessionName, text });
    } catch (err) {
      socket.emit('screen:history', { serverId, sessionName, error: err.message });
    }
  });

  // ── Notifications ──────────────────────────────────
  socket.on('watch:list', () => socket.emit('watch:list', { watches: notify.listWatches() }));

  socket.on('watch:set', ({ serverId = LOCAL_ID, pid, name, on, fullName, backend }) => {
    pid = String(pid || '');
    // The id is a screen pid (numeric) or a tmux session name — both match
    // SAFE_SESSION. Reject anything else (it reaches a shell command).
    if (!SAFE_SESSION.test(pid)) { socket.emit('servers:error', { message: 'Invalid session' }); return; }
    const clean = String(name || '').replace(/[^\w.\-]/g, '-').slice(0, 40) || pid;
    const fn = fullName && SAFE_SESSION.test(String(fullName)) ? String(fullName) : undefined;
    const be = backend === 'tmux' || backend === 'screen' ? backend : undefined;
    console.log('[watch]', on ? 'on' : 'off', serverId, pid, clean, be || '');
    setWatch(serverId, pid, clean, !!on, { fullName: fn, backend: be });
  });

  socket.on('push:key', (_, cb) => {
    if (typeof cb === 'function') cb({ key: notify.publicKey(), available: notify.pushAvailable() });
  });

  socket.on('push:subscribe', ({ subscription, ua }) => {
    try {
      const n = notify.addSubscription(subscription, { ua });
      console.log('[push] subscribed device, total:', n);
      socket.emit('push:subscribed', { ok: true, total: n });
    } catch (err) {
      socket.emit('push:subscribed', { ok: false, error: err.message });
    }
  });

  socket.on('push:unsubscribe', ({ endpoint }) => {
    if (endpoint) notify.removeSubscription(String(endpoint));
  });

  // Fire a push right now so a phone can confirm the whole chain works.
  socket.on('push:test', async () => {
    const payload = { title: 'termi', body: 'push notifications are working', url: '/', tag: 'termi-test', ts: Date.now() };
    let res = { sent: 0, total: 0 };
    try { res = await notify.sendPush(payload); } catch (_) {}
    socket.emit('push:test', res);
    if (!res.sent) io.emit('notify', { ...payload, pushed: false });
  });

  // ── Server registry events (dashboard) ─────────────
  socket.on('servers:list', () => {
    socket.emit('servers:list', serverListPayload());
    // Probe everything async; dashboards update as results land.
    probeAndEmit(LOCAL_ID).catch(() => {});
    for (const s of registry.listServers()) probeAndEmit(s.id).catch(() => {});
  });

  // ── Analytics page ─────────────────────────────────
  socket.on('analytics:get', async () => {
    const list = [{ id: LOCAL_ID, name: 'this server', local: true }, ...registry.listServers()];
    const names = {}; list.forEach(s => { names[s.id] = s.name; });
    const rows = await Promise.all(list.map(async (s) => {
      let probe = {};
      try { probe = await probeAndEmit(s.id); } catch (_) { probe = { online: false }; }
      const metrics = probe.online ? await gatherMetrics(s.id) : null;
      return {
        id: s.id, name: s.name, local: !!s.local,
        online: !!probe.online, error: probe.error,
        screens: probe.screens || 0, attached: probe.attached || 0,
        metrics, uptime: monitor.stats(s.id),
      };
    }));
    socket.emit('analytics:data', { rows, incidents: monitor.incidents(names), ts: Date.now() });
  });

  socket.on('servers:add', (input) => {
    try {
      let keyId = input.keyId;
      if (input.newKey && input.newKey.privateKey) {
        keyId = registry.addKey({ name: input.newKey.name || input.name + ' key', privateKey: input.newKey.privateKey, passphrase: input.newKey.passphrase }).id;
      }
      const server = registry.addServer({ ...input, keyId });
      io.emit('servers:list', serverListPayload());
      probeAndEmit(server.id, true).catch(() => {});
    } catch (err) {
      socket.emit('servers:error', { message: err.message });
    }
  });

  socket.on('servers:update', ({ id, ...input }) => {
    try {
      let keyId = input.keyId;
      if (input.newKey && input.newKey.privateKey) {
        keyId = registry.addKey({ name: input.newKey.name || input.name + ' key', privateKey: input.newKey.privateKey, passphrase: input.newKey.passphrase }).id;
      }
      registry.updateServer(id, { ...input, ...(keyId ? { keyId } : {}) });
      probeCache.delete(id);
      io.emit('servers:list', serverListPayload());
      probeAndEmit(id, true).catch(() => {});
    } catch (err) {
      socket.emit('servers:error', { message: err.message });
    }
  });

  socket.on('servers:remove', ({ id }) => {
    try {
      registry.removeServer(id);
      probeCache.delete(id);
      metricsCache.delete(id);
      monitor.forget(id);
      chats.delete(id);
      for (const w of notify.listWatches()) if (w.serverId === id) stopWatcher(notify.watchKey(id, w.pid));
      notify.removeServerWatches(id);
      io.emit('servers:list', serverListPayload());
    } catch (err) {
      socket.emit('servers:error', { message: err.message });
    }
  });

  socket.on('servers:test', async ({ id }) => {
    try {
      const result = await probeAndEmit(id, true);
      socket.emit('servers:test', { id, ...result });
    } catch (err) {
      socket.emit('servers:test', { id, online: false, error: err.message });
    }
  });

  socket.on('keys:add', (input) => {
    try {
      registry.addKey({ name: input.name, privateKey: input.privateKey, passphrase: input.passphrase });
      io.emit('servers:list', serverListPayload());
    } catch (err) {
      socket.emit('servers:error', { message: err.message });
    }
  });

  socket.on('keys:update', ({ id, ...input }) => {
    try {
      registry.updateKey(id, input);
      // Changed material can fix (or break) connectivity — re-probe dependents.
      for (const s of registry.listServers()) {
        if (s.keyId === id) { probeCache.delete(s.id); probeAndEmit(s.id, true).catch(() => {}); }
      }
      io.emit('servers:list', serverListPayload());
    } catch (err) {
      socket.emit('servers:error', { message: err.message });
    }
  });

  socket.on('keys:remove', ({ id }) => {
    try {
      registry.removeKey(id);
      io.emit('servers:list', serverListPayload());
    } catch (err) {
      socket.emit('servers:error', { message: err.message });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', socket.id, 'reason:', reason);
    detachAllScreens(socket.id);
    closeAllDirect(socket.id);
  });
});

// ── Background uptime monitor ─────────────────────────────
// Samples every server's reachability on an interval so downtime and
// uptime % accrue even when no dashboard is open.
function startMonitor() {
  const tick = async () => {
    const ids = [LOCAL_ID, ...registry.listServers().map(s => s.id)];
    for (const id of ids) {
      let online = false;
      try { online = !!(await probeAndEmit(id)).online; } catch (_) { online = false; }
      monitor.record(id, online, Date.now());
    }
  };
  tick().catch(() => {});
  return setInterval(() => tick().catch(() => {}), 60000);
}

// ── Start server ─────────────────────────────────────────
if (require.main === module) {
  server.listen(PORT, () => console.log(`Agent UI on port ${PORT} | workdir: ${WORK_DIR}`));
  startMonitor();
  startWatchers();
  console.log('[push]', notify.pushAvailable() ? 'web-push ready' : 'web-push not installed — in-app alerts only');
}

// ── Exports for testing ──────────────────────────────────
module.exports = {
  app, server, io,
  parseScreenLs,
  parseMetrics,
  listScreenSessions,
  screenPtys,
  watchers,
  screenHistory,
  spawnRunner,
  runCommand,
  chatState,
  getState: () => {
    const st = chatState(LOCAL_ID);
    return { queue: st.queue, hasSession: st.hasSession, agentRunning: st.agentRunning, agentType: st.agentType, lastResponse: st.lastResponse, pendingOutput: st.pendingOutput };
  },
  resetState: () => { chats.clear(); },
  AUTH_TOKEN,
  PORT,
};
