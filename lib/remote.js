// SSH connection layer for termi v2.
// One pooled ssh2 connection per server, multiplexing exec/pty channels.
// Host keys are pinned on first use (TOFU) and verified afterwards.
const { Client } = require('ssh2');
const crypto = require('crypto');
const registry = require('./registry');

const pool = new Map(); // serverId → { client, ready: Promise, alive }

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function connect(server) {
  return new Promise((resolve, reject) => {
    const cfg = {
      host: server.host,
      port: server.port || 22,
      username: server.user,
      readyTimeout: 12000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      hostVerifier: (key) => {
        const fp = fingerprint(key);
        if (!server.hostKeyFp) { registry.pinHostKey(server.id, fp); return true; }
        if (server.hostKeyFp === fp) return true;
        console.error(`[ssh] HOST KEY MISMATCH for ${server.name} (${server.host}) — expected ${server.hostKeyFp}, got ${fp}`);
        return false;
      },
    };

    let password;
    if ((server.authType || 'key') === 'password') {
      password = registry.getServerPassword(server.id);
      if (!password) return reject(new Error('No password stored for this server'));
      cfg.password = password;
      cfg.tryKeyboard = true; // many password-only servers use keyboard-interactive
    } else {
      let material;
      try { material = registry.getKeyMaterial(server.keyId); }
      catch (e) { return reject(e); }
      cfg.privateKey = material.privateKey;
      cfg.passphrase = material.passphrase;
    }

    const client = new Client();
    let settled = false;

    client.on('ready', () => { settled = true; resolve(client); });
    client.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    // Answer keyboard-interactive prompts with the stored password.
    client.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
      finish(prompts.map(() => password || ''));
    });

    client.connect(cfg);
  });
}

async function getClient(serverId) {
  const server = registry.getServer(serverId);
  if (!server) throw new Error('Unknown server: ' + serverId);

  const entry = pool.get(serverId);
  if (entry) {
    try {
      const client = await entry.ready;
      if (entry.alive) return client;
    } catch { /* fall through to reconnect */ }
    pool.delete(serverId);
  }

  const fresh = { alive: false, client: null, ready: null };
  fresh.ready = connect(server).then((client) => {
    fresh.client = client;
    fresh.alive = true;
    const drop = () => { fresh.alive = false; pool.delete(serverId); };
    client.on('close', drop);
    client.on('error', drop);
    return client;
  });
  pool.set(serverId, fresh);
  return fresh.ready;
}

// Run a command on the target (login shell so PATH matches an ssh login).
function execOnServer(serverId, command, { timeout = 20000 } = {}) {
  return getClient(serverId).then((client) => new Promise((resolve, reject) => {
    const cmd = `bash -lc ${shq(command)}`;
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { stream.close(); } catch (_) {} reject(new Error('Timeout: ' + command)); }, timeout);
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    });
  }));
}

// Open a remote PTY running `command`, returning a node-pty-like handle so
// the caller can treat local and remote terminals identically.
function openRemotePty(serverId, command, { cols = 80, rows = 24 } = {}) {
  return getClient(serverId).then((client) => new Promise((resolve, reject) => {
    client.exec(`bash -lc ${shq(command)}`, { pty: { term: 'xterm-256color', cols, rows } }, (err, stream) => {
      if (err) return reject(err);
      const handle = {
        write: (data) => { try { stream.write(data); } catch (_) {} },
        resize: (c, r) => { try { stream.setWindow(r, c, 0, 0); } catch (_) {} },
        kill: () => { try { stream.close(); } catch (_) {} },
        onData: (fn) => { stream.on('data', (d) => fn(d.toString('utf8'))); stream.stderr.on('data', (d) => fn(d.toString('utf8'))); },
        onExit: (fn) => { stream.on('close', (code) => fn({ exitCode: code == null ? 0 : code })); },
      };
      resolve(handle);
    });
  }));
}

// Stream a long-running command's stdout (for remote agent CLIs).
function streamOnServer(serverId, command, onChunk) {
  return getClient(serverId).then((client) => new Promise((resolve, reject) => {
    client.exec(`bash -lc ${shq(command)}`, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); onChunk(stdout); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', () => resolve(stdout || stderr || ''));
    });
  }));
}

// Probe a server: reachable? screen/claude/agent available? screen count?
async function probeServer(serverId) {
  try {
    const { stdout } = await execOnServer(serverId,
      'echo BEGIN; which screen && echo HAS_SCREEN; which claude && echo HAS_CLAUDE; which agent && echo HAS_AGENT; screen -ls 2>&1 || true',
      { timeout: 12000 });
    return {
      online: stdout.includes('BEGIN'),
      hasScreen: stdout.includes('HAS_SCREEN'),
      hasClaude: stdout.includes('HAS_CLAUDE'),
      hasAgent: stdout.includes('HAS_AGENT'),
      screenLs: stdout.split('BEGIN').pop() || '',
    };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// Write a buffer to a file on the target over SFTP. Relative paths resolve
// against the SSH user's home directory.
function uploadBuffer(serverId, buf, remotePath) {
  return getClient(serverId).then((client) => new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      const done = (fn) => (arg) => { try { sftp.end(); } catch (_) {} fn(arg); };
      const ws = sftp.createWriteStream(remotePath, { mode: 0o644 });
      ws.on('error', done(reject));
      ws.on('close', done(resolve));
      ws.end(buf);
    });
  }));
}

function closeAll() {
  for (const [, entry] of pool) { try { entry.client && entry.client.end(); } catch (_) {} }
  pool.clear();
}

// Single-quote for shell safety.
function shq(s) { return `'` + String(s).replace(/'/g, `'\\''`) + `'`; }

module.exports = { getClient, execOnServer, openRemotePty, streamOnServer, probeServer, uploadBuffer, closeAll, shq };
