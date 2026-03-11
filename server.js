const express = require('express');
const { exec, spawn } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const util = require('util');
const os = require('os');

const execAsync = util.promisify(exec);

// ── Resolve agent binary path ─────────────────────────────
// PM2 on macOS uses minimal PATH — agent binary may not be found
// Add common install locations explicitly
const EXTRA_PATHS = [
  '/opt/homebrew/bin',           // macOS Apple Silicon brew
  '/usr/local/bin',              // macOS Intel brew + Linux
  '/usr/bin',
  `${os.homedir()}/.local/bin`,  // user installs
  `${os.homedir()}/.cursor/bin`, // cursor specific
  `${os.homedir()}/.nvm/versions/node/*/bin`, // nvm
].join(':');

const AGENT_ENV = {
  ...process.env,
  PATH: `${EXTRA_PATHS}:${process.env.PATH || ''}`
};

// Find actual agent binary path on startup
let AGENT_BIN = 'agent';
try {
  AGENT_BIN = require('child_process')
    .execSync('which agent', { env: AGENT_ENV })
    .toString()
    .trim();
  console.log(`[termi] agent binary: ${AGENT_BIN}`);
} catch {
  console.warn('[termi] agent not found in PATH — will retry on connection');
}

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

let hasSession = false;
let agentRunning = false;
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
    const output = await runAgent(next.message, (chunk) => {
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
function runAgent(message, onChunk) {
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

    const args = ['--print', '--trust', '--yolo'];
    if (hasSession) args.push('--continue');

    const proc = spawn(AGENT_BIN, args, {
      cwd: WORK_DIR,
      env: AGENT_ENV,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdin.write(message + '\n');
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

// ── Socket ────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token !== AUTH_TOKEN) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id, 'transport:', socket.conn.transport.name);

  socket.on('init', async () => {
    try {
      // Re-resolve agent path in case it wasn't found on startup
      if (AGENT_BIN === 'agent') {
        try {
          AGENT_BIN = require('child_process')
            .execSync('which agent', { env: AGENT_ENV })
            .toString().trim();
          console.log(`[termi] agent resolved: ${AGENT_BIN}`);
        } catch {
          throw new Error('agent binary not found');
        }
      }

      await execAsync(`${AGENT_BIN} --version`, { env: AGENT_ENV }).catch(() => {});

      // Catch up if agent is still running
      if (agentRunning && pendingOutput) {
        socket.emit('response', { type: 'thinking', content: pendingOutput });
      }

      // Resend last response if client missed it
      if (lastResponse && !agentRunning) {
        console.log('[init] resending lastResponse to', socket.id);
        socket.emit('response', lastResponse);
      }

      socket.emit('queue', queue);

      socket.emit('status', {
        connected: true,
        message: agentRunning
          ? 'Agent is busy — reconnected, catching up...'
          : hasSession
            ? 'Reconnected — session context intact'
            : `Ready — ${WORK_DIR}`
      });
    } catch {
      socket.emit('status', {
        connected: false,
        message: 'agent not found in PATH.'
      });
    }
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

  socket.on('command', async ({ command }) => {
    try {
      socket.emit('response', { type: 'thinking', content: `Running: ${command}` });
      const output = await runCommand(command);
      const cmdResponse = { type: 'command', content: output };
      lastResponse = cmdResponse;
      socket.emit('response', cmdResponse);
    } catch (err) {
      socket.emit('response', { type: 'error', content: err.message });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', socket.id, 'reason:', reason, 'agent running:', agentRunning);
  });
});

server.listen(PORT, () => console.log(`Agent UI on port ${PORT} | workdir: ${WORK_DIR}`));
