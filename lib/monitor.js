// Uptime / downtime tracker for termi v2.
// Records reachability samples per server and persists a compact history so
// uptime % and incident timelines survive restarts.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'uptime.json');
const MAX_EVENTS = 200; // transitions kept per server

let state = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { state = {}; }
  return state;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 });
  } catch (_) { /* best-effort */ }
}

// Record a reachability sample. `now` is ms since epoch (passed in so the
// caller controls the clock and tests stay deterministic).
function record(serverId, online, now) {
  const s = load();
  let e = s[serverId];
  if (!e) e = s[serverId] = { checks: 0, up: 0, since: now, lastOnline: null, lastDown: null, events: [] };
  e.checks++;
  if (online) { e.up++; e.lastOnline = now; } else { e.lastDown = now; }
  const prev = e.events.length ? e.events[e.events.length - 1].online : null;
  if (prev !== online) {
    e.events.push({ t: now, online });
    if (e.events.length > MAX_EVENTS) e.events.splice(0, e.events.length - MAX_EVENTS);
    e.since = now; // current state started here
  }
  save();
}

function stats(serverId) {
  const e = load()[serverId];
  if (!e) return { uptimePct: null, checks: 0, since: null, lastOnline: null, lastDown: null, events: [] };
  return {
    uptimePct: e.checks ? Math.round((e.up / e.checks) * 1000) / 10 : null,
    checks: e.checks,
    since: e.since,
    lastOnline: e.lastOnline,
    lastDown: e.lastDown,
    events: e.events.slice(-30),
  };
}

// Recent transitions across the whole fleet, newest first.
function incidents(names, limit = 25) {
  const s = load();
  const out = [];
  for (const [id, e] of Object.entries(s)) {
    for (const ev of e.events) out.push({ id, name: (names && names[id]) || id, t: ev.t, online: ev.online });
  }
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, limit);
}

function forget(serverId) {
  const s = load();
  delete s[serverId];
  save();
}

module.exports = { record, stats, incidents, forget, _file: FILE };
