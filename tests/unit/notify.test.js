const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termi-notify-'));
process.env.DATA_DIR = tmpDir;
const notify = require('../../lib/notify');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('IdleDetector', () => {
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('fires after a working run goes quiet, with a summary', async () => {
    const fired = [];
    const d = new notify.IdleDetector({ idleMs: 40, minRunMs: 1000, minBytes: 100000, muteMs: 0, onIdle: i => fired.push(i) });
    d.feed('\x1b[2K✻ Thinking… (esc to interrupt)\r\n');
    d.feed('⏺ I updated server.js and the tests pass.\r\n');
    d.feed('╭──────────╮\r\n│ > \x1b[7m \x1b[0m │\r\n╰──────────╯\r\n');
    await sleep(90);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].working, true);
    assert.equal(fired[0].needsInput, false);
    assert.match(fired[0].snippet, /updated server\.js/);
  });

  it('flags permission prompts as needing input', async () => {
    const fired = [];
    const d = new notify.IdleDetector({ idleMs: 40, minRunMs: 1000, minBytes: 100000, muteMs: 0, onIdle: i => fired.push(i) });
    d.feed('✶ Working… (esc to interrupt)\r\n');
    d.feed('Bash(rm -rf build)\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n');
    await sleep(90);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].needsInput, true);
    assert.equal(fired[0].snippet, 'Bash(rm -rf build) · Do you want to proceed?');
  });

  it('ignores short bursts (keystroke echo, redraws)', async () => {
    const fired = [];
    const d = new notify.IdleDetector({ idleMs: 30, minRunMs: 1000, minBytes: 2000, muteMs: 0, onIdle: i => fired.push(i) });
    d.feed('l'); d.feed('s'); d.feed('\x1b[2J\x1b[H$ ls');
    await sleep(80);
    assert.equal(fired.length, 0);
  });

  it('fires for a long busy run even without the working marker', async () => {
    const fired = [];
    const d = new notify.IdleDetector({ idleMs: 60, minRunMs: 30, minBytes: 200, muteMs: 0, onIdle: i => fired.push(i) });
    d.feed('x'.repeat(150) + '\n'); await sleep(25);
    d.feed('y'.repeat(150) + '\n'); await sleep(25);
    d.feed('build finished ok\n');
    await sleep(120);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].working, false);
    assert.match(fired[0].snippet, /build finished ok/);
  });

  it('mutes the attach redraw', async () => {
    const fired = [];
    const d = new notify.IdleDetector({ idleMs: 20, minRunMs: 0, minBytes: 0, muteMs: 500, onIdle: i => fired.push(i) });
    d.feed('(esc to interrupt)');
    await sleep(60);
    assert.equal(fired.length, 0);
  });
});

describe('summarize / stripAnsi', () => {
  it('strips CSI, OSC and charset escapes', () => {
    assert.equal(notify.stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;title\x07\x1b(B\x1b[?25hdone'), 'ok done');
  });
  it('skips prompt chrome and shell prompts in the snippet', () => {
    const s = notify.summarize('⏺ All 12 tests pass.\n╭──╮\n│ > │\n╰──╯\n? for shortcuts\nroot@box:/srv/app# \n');
    assert.equal(s.snippet, '⏺ All 12 tests pass.');
  });
  it('skips box-drawing furniture lines in the snippet', () => {
    const s = notify.summarize('╭───╮\n│ hello there │\n╰───╯\n──────\n> \n');
    assert.match(s.snippet, /hello there/);
  });
});

describe('watch list + subscriptions persist', () => {
  it('adds, renames, removes watches', () => {
    notify.addWatch({ serverId: 'local', pid: 123, name: 'claude' });
    notify.addWatch({ serverId: 'srv_a', pid: '9', name: 'x' });
    assert.equal(notify.listWatches().length, 2);
    notify.renameWatch('local', '123', 'renamed');
    assert.equal(notify.listWatches().find(w => w.pid === '123').name, 'renamed');
    notify.removeWatch('local', '123');
    assert.equal(notify.listWatches().length, 1);
    notify.removeServerWatches('srv_a');
    assert.equal(notify.listWatches().length, 0);
    assert.ok(fs.existsSync(notify._files.WATCH_FILE));
  });

  it('dedupes subscriptions by endpoint and rejects junk', () => {
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
    assert.equal(notify.addSubscription(sub, { ua: 'test' }), 1);
    assert.equal(notify.addSubscription(sub), 1);
    assert.throws(() => notify.addSubscription({ endpoint: 42 }));
    assert.equal(notify.removeSubscription('https://push.example/abc'), 1);
    assert.equal(notify.listSubscriptions().length, 0);
  });

  it('exposes a VAPID public key when web-push is installed', () => {
    if (!notify.pushAvailable()) return;
    const k = notify.publicKey();
    assert.ok(typeof k === 'string' && k.length > 40);
    assert.equal(notify.publicKey(), k); // stable
  });
});
