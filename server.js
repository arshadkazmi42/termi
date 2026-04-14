const express = require('express');
const { exec, spawn } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const util = require('util');
const os = require('os');

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

let hasSession = false;
let agentRunning = false;
let agentType = process.env.AGENT_TYPE || 'agent'; // 'agent' or 'claude'

// Store last response server-side so mobile can get it on reconnect
let lastResponse = null;
let pendingOutput = '';

// ── Queue ─────────────────────────────────────────────
let queue = [];

function emitQueue() {
  io.emit('queue', queue);
}

async function processQueue() {
  if (agentRunning || queue.length === 0) return;

  const next = queue.shift();
  emitQueue();

  agentRunning = true;
  pendingOutput = '';
  lastResponse = null;

  io.emit('response', { type: 'thinking', content: `Running: ${next.message}` });

  // Keepalive — emit heartbeat every 20s so mobile knows agent is still working
  const keepalive = setInterval(() => {
    if (agentRunning) {
      io.emit('keepalive', { running: true });
      console.log('[keepalive] agent still running, output length:', pendingOutput.length);
    }
  }, 20000);

  try {
    const output = await runActive(next.message, (chunk) => {
      io.emit('response', { type: 'thinking', content: chunk });
    });

    clearInterval(keepalive);
    hasSession = true;
    agentRunning = false;

    lastResponse = { type: 'agent', content: output };
    pendingOutput = '';

    console.log('[agent] completed, emitting final response, length:', output.length);
    io.emit('response', lastResponse);

  } catch (err) {
    clearInterval(keepalive);
    agentRunning = false;
    lastResponse = { type: 'error', content: err.message };
    io.emit('response', lastResponse);
  }

  processQueue();
}

// ── Agent ─────────────────────────────────────────────
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
      const chunk = data.toString();
      output += chunk;
      pendingOutput = output;
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

function runAgent(message, onChunk) {
  const args = ['--print', '--trust', '--yolo'];
  if (hasSession) args.push('--continue');
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

function runClaudeCode(message, onChunk) {
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';

    const userInfo = getClaudeUid();
    const args = ['--print', '--dangerously-skip-permissions'];
    if (hasSession) args.push('--continue');
    args.push(message);

    const spawnOpts = {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        HOME: userInfo ? userInfo.home : process.env.HOME,
        USER: CLAUDE_USER,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(userInfo ? { uid: userInfo.uid, gid: userInfo.gid } : {}),
    };

    const proc = spawn('claude', args, spawnOpts);
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      pendingOutput = output;
      onChunk(output);
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', () => {
      agentRunning = false;
      if (output) resolve(output);
      else if (error) resolve(`STDERR: ${error}`);
      else resolve('Claude completed with no output.');
    });

    proc.on('error', (err) => {
      agentRunning = false;
      reject(err);
    });
  });
}

function runActive(message, onChunk) {
  return agentType === 'claude' ? runClaudeCode(message, onChunk) : runAgent(message, onChunk);
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

// ── Screen Session Management ────────────────────────────
const SCREEN_POLL_INTERVAL = 1000;
const TMP_DIR = '/tmp';
const screenBuffers = new Map();

async function listScreenSessions() {
  try {
    const { stdout } = await execAsync('screen -ls', { timeout: 5000 });
    return parseScreenLs(stdout);
  } catch (err) {
    if (err.stdout) return parseScreenLs(err.stdout);
    return [];
  }
}

function parseScreenLs(output) {
  const sessions = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\t(\d+)\.(\S+)\t\(([^)]+)\)/);
    if (!match) continue;
    const pid = match[1];
    const name = match[2];
    const statusRaw = match[3].toLowerCase();
    const attached = statusRaw.includes('attached');
    sessions.push({ pid, name, fullName: `${pid}.${name}`, status: attached ? 'attached' : 'detached' });
  }
  return sessions;
}

async function captureScreenOutput(sessionName) {
  const safeName = sessionName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpFile = path.join(TMP_DIR, `termi_screen_${safeName}.txt`);
  try {
    await execAsync(`screen -S ${sessionName} -X hardcopy -h ${tmpFile}`, { timeout: 5000 });
    return await fs.promises.readFile(tmpFile, 'utf-8');
  } catch (_) {
    return null;
  }
}

async function sendScreenInput(sessionName, message) {
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    await execAsync(`screen -S ${sessionName} -X stuff "${escaped}\n"`, { timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

function startScreenPolling(socket, sessionName) {
  const key = `${socket.id}:${sessionName}`;
  stopScreenPolling(socket, sessionName);
  const state = { lastContent: '', interval: null };
  state.interval = setInterval(async () => {
    const content = await captureScreenOutput(sessionName);
    if (content === null) return;
    if (content !== state.lastContent) {
      state.lastContent = content;
      socket.emit('screen:output', { content, full: true });
    }
  }, SCREEN_POLL_INTERVAL);
  screenBuffers.set(key, state);
}

function stopScreenPolling(socket, sessionName) {
  const key = `${socket.id}:${sessionName}`;
  const state = screenBuffers.get(key);
  if (state) {
    clearInterval(state.interval);
    screenBuffers.delete(key);
  }
}

function stopAllScreenPolling(socketId) {
  for (const [key, state] of screenBuffers.entries()) {
    if (key.startsWith(`${socketId}:`)) {
      clearInterval(state.interval);
      screenBuffers.delete(key);
    }
  }
}

// ── Socket ────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token !== AUTH_TOKEN) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id, 'transport:', socket.conn.transport.name);

  socket.on('init', async () => {
    // Check availability of both CLIs
    const [agentAvail, claudeAvail] = await Promise.all([
      execAsync('which agent').then(() => true).catch(() => false),
      execAsync('which claude').then(() => true).catch(() => false),
    ]);

    if (!agentAvail && !claudeAvail) {
      socket.emit('status', { connected: false, message: 'No agent CLI found in PATH.' });
      return;
    }

    // If current agentType isn't available, fall back to what is
    if (agentType === 'agent' && !agentAvail && claudeAvail) agentType = 'claude';
    if (agentType === 'claude' && !claudeAvail && agentAvail) agentType = 'agent';

    // If agent is currently running — send current output so mobile catches up
    if (agentRunning && pendingOutput) {
      socket.emit('response', { type: 'thinking', content: pendingOutput });
    }

    // If we have a completed response the client may have missed — resend it
    if (lastResponse && !agentRunning) {
      console.log('[init] resending lastResponse to', socket.id);
      socket.emit('response', lastResponse);
    }

    socket.emit('queue', queue);

    socket.emit('status', {
      connected: true,
      agentType,
      agentAvail,
      claudeAvail,
      message: agentRunning
        ? 'Agent is busy — reconnected, catching up...'
        : hasSession
          ? 'Reconnected — session context intact'
          : `Ready — ${WORK_DIR}`
    });
  });

  socket.on('setAgent', ({ type }) => {
    if (!['agent', 'claude'].includes(type)) return;
    if (agentRunning) {
      socket.emit('response', { type: 'error', content: 'Cannot switch agents while one is running.' });
      return;
    }
    agentType = type;
    hasSession = false;
    lastResponse = null;
    pendingOutput = '';
    socket.emit('agentSwitched', { agentType });
    socket.emit('response', { type: 'system', content: `Switched to ${type === 'claude' ? 'Claude Code' : 'Cursor Agent'} — session reset.` });
  });

  socket.on('chat', ({ message }) => {
    const item = { id: Date.now(), message };
    queue.push(item);
    emitQueue();
    processQueue();
  });

  socket.on('queue:remove', ({ id }) => {
    queue = queue.filter(i => i.id !== id);
    emitQueue();
  });

  socket.on('queue:move', ({ id, direction }) => {
    const idx = queue.findIndex(i => i.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx > 0) {
      [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
    }
    if (direction === 'down' && idx < queue.length - 1) {
      [queue[idx], queue[idx + 1]] = [queue[idx + 1], queue[idx]];
    }
    emitQueue();
  });

  socket.on('queue:clear', () => {
    queue = [];
    emitQueue();
  });

  socket.on('reset', () => {
    if (agentRunning) {
      socket.emit('response', { type: 'error', content: 'Agent is busy. Wait for it to finish first.' });
      return;
    }
    hasSession = false;
    lastResponse = null;
    pendingOutput = '';
    queue = [];
    emitQueue();
    socket.emit('response', { type: 'system', content: 'Session reset — starting fresh.' });
  });

  // ── Screen session events ──────────────────────────
  socket.on('screen:list', async () => {
    const sessions = await listScreenSessions();
    socket.emit('screen:list', { sessions });
  });

  socket.on('screen:join', async ({ sessionName }) => {
    console.log('[screen] join:', sessionName);
    const content = await captureScreenOutput(sessionName);
    if (content !== null) socket.emit('screen:output', { content, full: true });
    startScreenPolling(socket, sessionName);
  });

  socket.on('screen:leave', ({ sessionName }) => {
    console.log('[screen] leave:', sessionName);
    stopScreenPolling(socket, sessionName);
  });

  socket.on('screen:input', async ({ sessionName, message }) => {
    const ok = await sendScreenInput(sessionName, message);
    if (!ok) socket.emit('screen:error', { message: 'Failed to send input to session' });
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', socket.id, 'reason:', reason, 'agent running:', agentRunning);
    stopAllScreenPolling(socket.id);
  });
});

// ── Start server ─────────────────────────────────────────
if (require.main === module) {
  server.listen(PORT, () => console.log(`Agent UI on port ${PORT} | workdir: ${WORK_DIR}`));
}

// ── Exports for testing ──────────────────────────────────
module.exports = {
  app, server, io,
  parseScreenLs,
  captureScreenOutput,
  sendScreenInput,
  listScreenSessions,
  startScreenPolling,
  stopScreenPolling,
  stopAllScreenPolling,
  screenBuffers,
  spawnRunner,
  runCommand,
  getState: () => ({ queue, hasSession, agentRunning, agentType, lastResponse, pendingOutput }),
  resetState: () => { queue = []; hasSession = false; agentRunning = false; lastResponse = null; pendingOutput = ''; agentType = 'agent'; },
  AUTH_TOKEN,
  PORT,
};