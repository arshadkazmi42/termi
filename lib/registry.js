// Server & SSH-key registry for termi v2.
// Stores targets in a JSON file; SSH private keys are encrypted at rest
// with AES-256-GCM using a key derived (scrypt) from AUTH_TOKEN, so a
// leaked registry file alone doesn't leak keys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const REG_FILE = path.join(DATA_DIR, 'registry.json');

let secret = process.env.AUTH_TOKEN || 'changeme';
let cache = null;

function setSecret(s) { secret = s; cache = null; }

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
  } catch {
    cache = { salt: crypto.randomBytes(16).toString('hex'), keys: [], servers: [] };
  }
  if (!cache.salt) cache.salt = crypto.randomBytes(16).toString('hex');
  if (!Array.isArray(cache.keys)) cache.keys = [];
  if (!Array.isArray(cache.servers)) cache.servers = [];
  return cache;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REG_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function kek() {
  const reg = load();
  return crypto.scryptSync(secret, Buffer.from(reg.salt, 'hex'), 32);
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { enc: enc.toString('base64'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function decrypt({ enc, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

// ── Keys ──────────────────────────────────────────────────
function addKey({ name, privateKey, passphrase }) {
  if (!privateKey || !/PRIVATE KEY/.test(privateKey)) throw new Error('Not a valid private key (PEM/OpenSSH format expected)');
  const reg = load();
  const id = newId('key');
  reg.keys.push({
    id, name: String(name || 'key').slice(0, 60),
    ...encrypt(privateKey.trim() + '\n'),
    ...(passphrase ? { pp: encrypt(String(passphrase)) } : {}),
    createdAt: new Date().toISOString(),
  });
  save();
  return { id };
}

function listKeys() {
  return load().keys.map(k => ({ id: k.id, name: k.name, createdAt: k.createdAt }));
}

function getKeyMaterial(id) {
  const k = load().keys.find(k => k.id === id);
  if (!k) throw new Error('Key not found: ' + id);
  return { privateKey: decrypt(k), passphrase: k.pp ? decrypt(k.pp) : undefined };
}

// Rename, replace material, or set a passphrase. An empty privateKey keeps
// the current material (so a passphrase can be added to a stored key alone).
function updateKey(id, { name, privateKey, passphrase }) {
  const reg = load();
  const k = reg.keys.find(x => x.id === id);
  if (!k) throw new Error('Key not found');
  if (name) k.name = String(name).slice(0, 60);
  if (privateKey) {
    if (!/PRIVATE KEY/.test(privateKey)) throw new Error('Not a valid private key (PEM/OpenSSH format expected)');
    Object.assign(k, encrypt(privateKey.trim() + '\n'));
    if (passphrase) k.pp = encrypt(String(passphrase));
    else delete k.pp;
  } else if (passphrase) {
    k.pp = encrypt(String(passphrase));
  }
  save();
}

function removeKey(id) {
  const reg = load();
  const used = reg.servers.filter(s => s.keyId === id);
  if (used.length) throw new Error('Key is used by: ' + used.map(s => s.name).join(', '));
  reg.keys = reg.keys.filter(k => k.id !== id);
  save();
}

// ── Servers ───────────────────────────────────────────────
// A server authenticates with either an SSH key (keyId) or a password
// (pw, encrypted per-server). authType picks which.
function sanitizeServer(input, existing) {
  const s = existing || {};
  const host = String(input.host ?? s.host ?? '').trim();
  if (!host || !/^[\w.:\-\[\]]+$/.test(host)) throw new Error('Invalid host');
  const port = parseInt(input.port ?? s.port ?? 22, 10);
  if (!(port >= 1 && port <= 65535)) throw new Error('Invalid port');
  const user = String(input.user ?? s.user ?? 'root').trim();
  if (!user || !/^[\w.\-]+$/.test(user)) throw new Error('Invalid user');
  const name = String(input.name ?? s.name ?? host).trim().slice(0, 60) || host;
  const authType = input.authType ?? s.authType ?? 'key';
  if (!['key', 'password'].includes(authType)) throw new Error('Invalid auth type');
  const clean = { name, host, port, user, authType };
  if (authType === 'key') {
    const keyId = input.keyId ?? s.keyId;
    if (!load().keys.some(k => k.id === keyId)) throw new Error('Pick an SSH key');
    clean.keyId = keyId;
  }
  return clean;
}

function addServer(input) {
  const reg = load();
  const clean = sanitizeServer(input);
  const server = { id: newId('srv'), ...clean, hostKeyFp: null, createdAt: new Date().toISOString() };
  if (clean.authType === 'password') {
    if (!input.password) throw new Error('Password required');
    server.pw = encrypt(String(input.password));
  }
  reg.servers.push(server);
  save();
  return server;
}

function updateServer(id, input) {
  const reg = load();
  const s = reg.servers.find(s => s.id === id);
  if (!s) throw new Error('Server not found');
  const clean = sanitizeServer(input, s);
  const hostChanged = clean.host !== s.host || clean.port !== s.port;
  Object.assign(s, clean);
  if (clean.authType === 'password') {
    if (input.password) s.pw = encrypt(String(input.password));
    else if (!s.pw) throw new Error('Password required');
    delete s.keyId;
  } else {
    delete s.pw; // switched to key auth
  }
  if (hostChanged) s.hostKeyFp = null; // re-pin on next connect
  save();
  return s;
}

function removeServer(id) {
  const reg = load();
  reg.servers = reg.servers.filter(s => s.id !== id);
  save();
}

function listServers() {
  return load().servers.map(({ id, name, host, port, user, authType, keyId, createdAt }) =>
    ({ id, name, host, port, user, authType: authType || 'key', keyId, createdAt }));
}

function getServer(id) {
  return load().servers.find(s => s.id === id) || null;
}

// Decrypted password for a password-auth server (used only at connect time).
function getServerPassword(id) {
  const s = load().servers.find(s => s.id === id);
  return (s && s.pw) ? decrypt(s.pw) : undefined;
}

// Trust-on-first-use host key pinning
function pinHostKey(id, fp) {
  const reg = load();
  const s = reg.servers.find(s => s.id === id);
  if (s) { s.hostKeyFp = fp; save(); }
}

module.exports = {
  setSecret, addKey, listKeys, getKeyMaterial, updateKey, removeKey,
  addServer, updateServer, removeServer, listServers, getServer, getServerPassword, pinHostKey,
  _encrypt: encrypt, _decrypt: decrypt, _load: load,
  REG_FILE, DATA_DIR,
};
