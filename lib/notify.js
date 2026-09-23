// Notifications for termi: "your session went quiet" pushes.
//
// A watched screen session gets a hub-side display attached permanently. Its
// byte stream feeds an IdleDetector: while Claude Code (or anything else)
// works, output keeps flowing — spinners, streamed text, tool logs. When it
// stops for a few seconds the run is over: the agent finished, or it is
// sitting on a question. That moment becomes a Web Push notification (and an
// in-app event for clients that are connected).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'push.json');
const WATCH_FILE = path.join(DATA_DIR, 'watch.json');
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || 'mailto:termi@localhost';
const MAX_SUBS = 50;

let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* push disabled, in-app only */ }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (_) { /* best-effort */ }
}

// ── VAPID keys (generated once, kept in DATA_DIR) ───────
let vapidCache = null;
function vapid() {
  if (vapidCache) return vapidCache;
  if (!webpush) return null;
  let v = readJson(VAPID_FILE, null);
  if (!v || !v.publicKey || !v.privateKey) {
    v = webpush.generateVAPIDKeys();
    writeJson(VAPID_FILE, v);
  }
  vapidCache = v;
  return v;
}
function publicKey() { const v = vapid(); return v ? v.publicKey : null; }
function pushAvailable() { return !!webpush; }

// ── Push subscriptions ──────────────────────────────────
let subs = null;
function loadSubs() { if (!subs) subs = readJson(SUBS_FILE, []).filter(s => s && s.endpoint); return subs; }
function listSubscriptions() { return loadSubs().slice(); }
function addSubscription(sub, meta = {}) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw new Error('invalid subscription');
  const list = loadSubs().filter(s => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime || null, ua: meta.ua || '', addedAt: Date.now() });
  while (list.length > MAX_SUBS) list.shift();
  subs = list; writeJson(SUBS_FILE, subs);
  return subs.length;
}
function removeSubscription(endpoint) {
  const before = loadSubs().length;
  subs = loadSubs().filter(s => s.endpoint !== endpoint);
  if (subs.length !== before) writeJson(SUBS_FILE, subs);
  return before - subs.length;
}

// Send one payload to every subscribed device; drop subscriptions the push
// service reports as gone.
async function sendPush(payload) {
  const v = vapid();
  if (!v) return { sent: 0, failed: 0, total: 0 };
  const list = loadSubs();
  let sent = 0, failed = 0;
  await Promise.all(list.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), {
        TTL: 600, vapidDetails: { subject: PUSH_SUBJECT, publicKey: v.publicKey, privateKey: v.privateKey },
      });
      sent++;
    } catch (err) {
      failed++;
      const code = err && err.statusCode;
      if (code === 404 || code === 410) removeSubscription(s.endpoint);
      console.log('[push] send failed:', code || err.message);
    }
  }));
  return { sent, failed, total: list.length };
}

// ── Watch list (which sessions to monitor) ──────────────
let watches = null;
function loadWatches() {
  if (!watches) watches = readJson(WATCH_FILE, []).filter(w => w && w.serverId && w.pid);
  return watches;
}
function watchKey(serverId, pid) { return `${serverId}:${pid}`; }
function listWatches() { return loadWatches().map(w => ({ ...w })); }
function addWatch({ serverId, pid, name }) {
  const list = loadWatches().filter(w => watchKey(w.serverId, w.pid) !== watchKey(serverId, pid));
  list.push({ serverId, pid: String(pid), name: String(name || pid), addedAt: Date.now() });
  watches = list; writeJson(WATCH_FILE, watches);
}
function removeWatch(serverId, pid) {
  watches = loadWatches().filter(w => watchKey(w.serverId, w.pid) !== watchKey(serverId, pid));
  writeJson(WATCH_FILE, watches);
}
function renameWatch(serverId, pid, name) {
  const w = loadWatches().find(x => watchKey(x.serverId, x.pid) === watchKey(serverId, pid));
  if (w) { w.name = name; writeJson(WATCH_FILE, watches); }
}
function removeServerWatches(serverId) {
  watches = loadWatches().filter(w => w.serverId !== serverId);
  writeJson(WATCH_FILE, watches);
}

// ── Idle detection ──────────────────────────────────────
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g;
const ESC_RE = /\x1b[()#%][@-~]|\x1b[^[\]]/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
function stripAnsi(s) {
  return String(s).replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(CTRL_RE, '');
}

// Claude Code shows "(esc to interrupt)" for as long as it is working — the
// most reliable "this was the agent, not the user typing" signal there is.
const WORKING_RE = /esc to interrupt/i;
// Permission dialogs and questions: Claude's "Do you want to…?" lists, y/n
// prompts, and its numbered-choice menus.
const INPUT_RE = /do you want|yes,\s|\(y\/n\)|\[y\/n\]|allow|permission|approve|esc to cancel|❯\s*1\./i;
// Lines that are only box drawing / prompt furniture say nothing in a
// notification body.
const FURNITURE_RE = /^[\s─│╭╮╰╯━┃┏┓┗┛┌┐└┘├┤┬┴┼═║╔╗╚╝>?·•⏵⏸⎿✻✳✶✽✢…\-_=+*#|]*$/;

// Chrome that is always on screen and says nothing about what happened:
// Claude Code's input box and status line, shell prompts.
const NOISE_RE = /^(>\s|\?\s*for shortcuts|⏵⏵|auto-accept|bypass permissions|plan mode|shift\+tab to cycle|esc to interrupt|[\w.-]+@[\w.-]+:.*[#$]\s*$|\$\s*$)/i;

function summarize(tail) {
  const lines = stripAnsi(tail).split(/\r?\n|\r/).map(l => l.trim()).filter(l => l && !FURNITURE_RE.test(l));
  const recent = lines.slice(-25);
  const needsInput = INPUT_RE.test(recent.join('\n'));
  const meaningful = recent.filter(l => /[a-z]/i.test(l) && !NOISE_RE.test(l));
  let pick = meaningful.slice(-2);
  if (needsInput) {
    // The question and the line before it (usually the tool call being asked about).
    let qi = -1;
    for (let i = meaningful.length - 1; i >= 0; i--) if (/\?$|do you want|allow|permission|approve/i.test(meaningful[i])) { qi = i; break; }
    if (qi >= 0) pick = meaningful.slice(Math.max(0, qi - 1), qi + 1);
  }
  return { needsInput, snippet: pick.join(' · ').slice(-140) };
}

class IdleDetector {
  constructor({ idleMs = 5000, minRunMs = 4000, minBytes = 2000, muteMs = 3000, onIdle } = {}) {
    this.idleMs = idleMs; this.minRunMs = minRunMs; this.minBytes = minBytes;
    this.onIdle = onIdle || (() => {});
    this.run = null; this.timer = null;
    this.muteUntil = Date.now() + muteMs; // the attach redraw is not activity
  }
  feed(data) {
    const now = Date.now();
    if (now < this.muteUntil) return;
    if (!this.run) this.run = { start: now, last: now, bytes: 0, tail: '', working: false };
    const r = this.run;
    r.bytes += data.length; r.last = now;
    r.tail = (r.tail + data).slice(-6000);
    if (!r.working && WORKING_RE.test(data)) r.working = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), this.idleMs);
    if (this.timer.unref) this.timer.unref();
  }
  fire() {
    const r = this.run; this.run = null;
    if (!r) return;
    const runMs = r.last - r.start;
    // An agent run, or anything that kept a terminal busy for a while (a
    // build, a test suite). A keystroke echo or a redraw does not qualify.
    if (!(r.working || (runMs >= this.minRunMs && r.bytes >= this.minBytes))) return;
    this.onIdle({ ...summarize(r.tail), runMs, bytes: r.bytes, working: r.working });
  }
  mute(ms) { this.muteUntil = Date.now() + ms; this.run = null; clearTimeout(this.timer); }
  dispose() { clearTimeout(this.timer); this.run = null; }
}

module.exports = {
  pushAvailable, publicKey, listSubscriptions, addSubscription, removeSubscription, sendPush,
  listWatches, addWatch, removeWatch, renameWatch, removeServerWatches, watchKey,
  IdleDetector, summarize, stripAnsi,
  _files: { VAPID_FILE, SUBS_FILE, WATCH_FILE },
};
