const express = require('express');
const { exec, spawn } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const PORT = process.env.PORT || 3619;
const WORK_DIR = process.env.WORK_DIR || '/root/workspace';

// Track if we have an existing session to continue
let hasSession = false;

function runAgent(message, socket, continueSession) {
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';

    const args = ['--print', '--trust', '--yolo'];
    if (continueSession) args.push('--continue');

    const proc = spawn('agent', args, {
      cwd: WORK_DIR,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdin.write(message + '\n');
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      output += data.toString();
      // Stream live to UI
      socket.emit('response', { type: 'thinking', content: output });
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', () => {
      if (output) resolve(output);
      else if (error) resolve(`STDERR: ${error}`);
      else resolve('No output received.');
    });

    proc.on('error', (err) => reject(err));
  });
}

async function runCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORK_DIR,
      timeout: 15000
    });
    return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token !== AUTH_TOKEN) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('init', async () => {
    try {
      await execAsync('which agent');
      socket.emit('status', {
        connected: true,
        message: hasSession
          ? `Reconnected — previous session context intact`
          : `Ready — workdir: ${WORK_DIR}`
      });
    } catch {
      socket.emit('status', {
        connected: false,
        message: `agent not found in PATH.`
      });
    }
  });

  socket.on('chat', async ({ message }) => {
    try {
      socket.emit('response', { type: 'thinking', content: 'Agent is thinking...' });
      const output = await runAgent(message, socket, hasSession);
      hasSession = true; // From now on always continue
      socket.emit('response', { type: 'agent', content: output });
    } catch (err) {
      socket.emit('response', { type: 'error', content: err.message });
    }
  });

  socket.on('reset', () => {
    hasSession = false;
    socket.emit('response', { type: 'system', content: 'Session reset. Next message starts fresh.' });
  });

  socket.on('command', async ({ command }) => {
    try {
      socket.emit('response', { type: 'thinking', content: `Running: ${command}` });
      const output = await runCommand(command);
      socket.emit('response', { type: 'command', content: output });
    } catch (err) {
      socket.emit('response', { type: 'error', content: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected — session context preserved');
  });
});

server.listen(PORT, () => console.log(`Agent UI on port ${PORT} | workdir: ${WORK_DIR}`));
