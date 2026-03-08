const express = require('express');
const { exec, spawn } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Increase timeouts for slow mobile connections
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const PORT = process.env.PORT || 3619;
const WORK_DIR = process.env.WORK_DIR || '/root/workspace';

let hasSession = false;
let agentRunning = false;

// Store last response server-side so mobile can get it on reconnect
let lastResponse = null;
let pendingOutput = '';

function runAgent(message, onChunk) {
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';

    const args = ['--print', '--trust', '--yolo'];
    if (hasSession) args.push('--continue');

    const proc = spawn('agent', args, {
      cwd: WORK_DIR,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdin.write(message + '\n');
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      pendingOutput = output;
      // Send chunk to any connected socket
      onChunk(output);
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', () => {
      agentRunning = false;
      if (output) resolve(output);
      else if (error) resolve(`STDERR: ${error}`);
      else resolve('Agent completed with no output.');
    });

    proc.on('error', (err) => {
      agentRunning = false;
      reject(err);
    });
  });
}

async function runCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORK_DIR,
      timeout: 30000
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
  console.log('Client connected:', socket.id);

  socket.on('init', async () => {
    try {
      await execAsync('which agent');

      // If agent is currently running — send current output so mobile catches up
      if (agentRunning && pendingOutput) {
        socket.emit('response', { type: 'thinking', content: pendingOutput });
      }

      // If we have a completed response the client may have missed — resend it
      if (lastResponse && !agentRunning) {
        socket.emit('response', lastResponse);
      }

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

  socket.on('chat', async ({ message }) => {
    if (agentRunning) {
      socket.emit('response', { type: 'error', content: 'Agent is busy. Wait for current task to finish.' });
      return;
    }

    try {
      agentRunning = true;
      pendingOutput = '';
      lastResponse = null;

      socket.emit('response', { type: 'thinking', content: 'Agent is thinking...' });

      const output = await runAgent(message, (chunk) => {
        // Broadcast to ALL connected sockets so any reconnected mobile gets it
        io.emit('response', { type: 'thinking', content: chunk });
      });

      hasSession = true;

      // Store final response server-side
      lastResponse = { type: 'agent', content: output };
      pendingOutput = '';

      // Broadcast final response to everyone
      io.emit('response', lastResponse);

    } catch (err) {
      agentRunning = false;
      const errResponse = { type: 'error', content: err.message };
      lastResponse = errResponse;
      io.emit('response', errResponse);
    }
  });

  socket.on('reset', () => {
    if (agentRunning) {
      socket.emit('response', { type: 'error', content: 'Agent is busy. Wait for it to finish first.' });
      return;
    }
    hasSession = false;
    lastResponse = null;
    pendingOutput = '';
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

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id, '— agent still running:', agentRunning);
  });
});

server.listen(PORT, () => console.log(`Agent UI on port ${PORT} | workdir: ${WORK_DIR}`));
