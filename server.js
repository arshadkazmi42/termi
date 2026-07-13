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

const execAsync = util.promisify(exec);

// ── Resolve agent binary path ─────────────────────────────
const EXTRA_PATHS = [
  '/Users/arshad/.local/bin',    // confirmed agent location
  '/opt/homebrew/bin',           // macOS Apple Silicon brew
  '/usr/local/bin',              // macOS Intel brew + Linux
  '/usr/bin',
  `${os.homedir()}/.local/bin`,
  `${os.homedir()}/.cursor/bin`,
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
    ? `echo ${b64} | base64 -d | claude --print --dangerously-skip-permissions${cont}`
    : `echo ${b64} | base64 -d | agent --print --trust --yolo${cont}`;
  return remote.streamOnServer(serverId, cmd, onChunk);
}

function runActive(serverId, message, onChunk) {
  const st = chatState(serverId);
  if (serverId !== LOCAL_ID) return runRemoteAgent(serverId, st, message, onChunk);
  return st.agentType === 'claude' ? runClaudeCode(st, message, onChunk) : runAgent(st, message, onChunk);
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
const screenPtys = new Map(); // key: `${socketId}:${serverId}:${sessionName}` → { handle, sessionName }

const SAFE_SESSION = /^[\w.\-]+$/;

async function listScreenSessions(serverId = LOCAL_ID) {
  try {
    if (serverId === LOCAL_ID) {
      const { stdout } = await execAsync('screen -ls', { timeout: 5000 });
      return parseScreenLs(stdout);
    }
    const { stdout } = await remote.execOnServer(serverId, 'screen -ls', { timeout: 10000 });
    return parseScreenLs(stdout);
  } catch (err) {
    if (err.stdout) return parseScreenLs(err.stdout);
    return [];
  }
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

function openLocalPty(sessionName, cols, rows) {
  const term = pty.spawn('screen', ['-x', sessionName], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: process.env.HOME,
    env: process.env,
  });
  return {
    write: (d) => term.write(d),
    resize: (c, r) => { try { term.resize(c, r); } catch (_) {} },
    kill: () => { try { term.kill(); } catch (_) {} },
    onData: (fn) => term.onData(fn),
    onExit: (fn) => term.onExit(fn),
  };
}

async function attachScreen(socket, serverId, sessionName, cols, rows) {
  if (!SAFE_SESSION.test(sessionName)) {
    socket.emit('screen:exit', { serverId, sessionName, exitCode: -1, error: 'Invalid session name' });
    return;
  }
  const key = `${socket.id}:${serverId}:${sessionName}`;
  detachScreen(socket, serverId, sessionName);

  console.log('[screen] attaching:', serverId, sessionName, `${cols}x${rows}`);

  let handle;
  try {
    handle = serverId === LOCAL_ID
      ? openLocalPty(sessionName, cols, rows)
      : await remote.openRemotePty(serverId, `screen -x ${sessionName}`, { cols: cols || 80, rows: rows || 24 });
  } catch (err) {
    console.log('[screen] attach failed:', serverId, sessionName, err.message);
    socket.emit('screen:exit', { serverId, sessionName, exitCode: -1, error: err.message });
    return;
  }

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

  screenPtys.set(key, { handle, sessionName });
}

function detachScreen(socket, serverId, sessionName) {
  const key = `${socket.id}:${serverId}:${sessionName}`;
  const entry = screenPtys.get(key);
  if (entry) {
    // Send detach key (Ctrl-A d) to cleanly leave without killing session
    entry.handle.write('\x01d');
    setTimeout(() => {
      try { entry.handle.kill(); } catch (_) {}
    }, 500);
    screenPtys.delete(key);
  }
}

function detachAllScreens(socketId) {
  for (const [key, entry] of screenPtys.entries()) {
    if (key.startsWith(`${socketId}:`)) {
      entry.handle.write('\x01d');
      setTimeout(() => {
        try { entry.handle.kill(); } catch (_) {}
      }, 500);
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
  if (entry) entry.handle.resize(cols, rows);
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
    const [agentAvail, claudeAvail] = await Promise.all([
      execAsync('which agent', { env: AGENT_ENV }).then(() => true).catch(() => false),
      execAsync('which claude', { env: AGENT_ENV }).then(() => true).catch(() => false),
    ]);
    result = {
      online: true, hasScreen: true, hasClaude: claudeAvail, hasAgent: agentAvail,
      screens: sessions.length, attached: sessions.filter(s => s.status === 'attached').length,
      sessions: sessions.slice(0, 16),
    };
  } else {
    const probe = await remote.probeServer(serverId);
    const sessions = probe.screenLs ? parseScreenLs(probe.screenLs) : [];
    result = {
      online: probe.online,
      hasScreen: !!probe.hasScreen,
      hasClaude: !!probe.hasClaude,
      hasAgent: !!probe.hasAgent,
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

io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id, 'transport:', socket.conn.transport.name);

  socket.on('init', async (payload) => {
    const serverId = (payload && payload.serverId) || LOCAL_ID;
    const st = chatState(serverId);

    let agentAvail = false, claudeAvail = false, online = true;
    try {
      const probe = await probeAndEmit(serverId);
      agentAvail = !!probe.hasAgent;
      claudeAvail = !!probe.hasClaude;
      online = !!probe.online;
    } catch (_) {}

    if (!online) {
      socket.emit('status', { serverId, connected: false, message: 'Server unreachable over SSH.' });
      return;
    }
    if (!agentAvail && !claudeAvail) {
      socket.emit('status', { serverId, connected: true, agentType: st.agentType, agentAvail, claudeAvail, message: 'No agent CLI found on this server.' });
      return;
    }

    // If current agentType isn't available, fall back to what is
    if (st.agentType === 'agent' && !agentAvail && claudeAvail) st.agentType = 'claude';
    if (st.agentType === 'claude' && !claudeAvail && agentAvail) st.agentType = 'agent';

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
      message: st.agentRunning
        ? 'Agent is busy — reconnected, catching up...'
        : st.hasSession
          ? 'Reconnected — session context intact'
          : serverId === LOCAL_ID ? `Ready — ${WORK_DIR}` : 'Ready'
    });
  });

  socket.on('setAgent', ({ type, serverId = LOCAL_ID }) => {
    if (!['agent', 'claude'].includes(type)) return;
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
    socket.emit('response', { serverId, type: 'system', content: `Switched to ${type === 'claude' ? 'Claude Code' : 'Cursor Agent'} — session reset.` });
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
    if (!SAFE_SESSION.test(clean)) return;
    console.log('[screen] create:', serverId, clean);
    try {
      if (serverId === LOCAL_ID) await execAsync(`screen -dmS ${clean}`, { timeout: 5000, cwd: WORK_DIR });
      else await remote.execOnServer(serverId, `screen -dmS ${clean}`, { timeout: 12000 });
      probeCache.delete(serverId);
      const sessions = await listScreenSessions(serverId);
      socket.emit('screen:list', { serverId, sessions });
    } catch (err) {
      socket.emit('servers:error', { message: 'Could not create screen session: ' + err.message });
    }
  });

  // Rename a session in place (screen keeps the pid, so the new fullName
  // is derivable). Broadcast so every client can remap open panes/URLs.
  socket.on('screen:rename', async ({ serverId = LOCAL_ID, sessionName, newName }) => {
    const clean = String(newName || '').replace(/[^\w.\-]/g, '-').slice(0, 40);
    if (!SAFE_SESSION.test(sessionName) || !clean || !SAFE_SESSION.test(clean)) return;
    console.log('[screen] rename:', serverId, sessionName, '→', clean);
    try {
      const cmd = `screen -S ${sessionName} -X sessionname ${clean}`;
      if (serverId === LOCAL_ID) await execAsync(cmd, { timeout: 5000 });
      else await remote.execOnServer(serverId, cmd, { timeout: 12000 });
      probeCache.delete(serverId);
      const pid = sessionName.split('.')[0];
      io.emit('screen:renamed', { serverId, oldFullName: sessionName, newFullName: `${pid}.${clean}` });
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

  socket.on('screen:input', ({ sessionName, data, serverId = LOCAL_ID }) => {
    sendScreenInput(socket, serverId, sessionName, data);
  });

  socket.on('screen:resize', ({ sessionName, cols, rows, serverId = LOCAL_ID }) => {
    resizeScreenPty(socket, serverId, sessionName, cols, rows);
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
}

// ── Exports for testing ──────────────────────────────────
module.exports = {
  app, server, io,
  parseScreenLs,
  parseMetrics,
  listScreenSessions,
  screenPtys,
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
