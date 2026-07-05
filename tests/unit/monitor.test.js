const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termi-mon-'));
process.env.DATA_DIR = tmpDir;
const monitor = require('../../lib/monitor');
const { parseMetrics } = require('../../server');

describe('monitor', () => {
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('tracks uptime % and records only transitions as events', () => {
    let t = 1000;
    monitor.record('s1', true, t += 1000);
    monitor.record('s1', true, t += 1000);
    monitor.record('s1', false, t += 1000); // transition → down
    monitor.record('s1', true, t += 1000);  // transition → up
    const st = monitor.stats('s1');
    assert.equal(st.checks, 4);
    assert.equal(st.uptimePct, 75); // 3 of 4 up
    assert.equal(st.events.length, 3); // up, down, up
    assert.equal(st.events[0].online, true);
    assert.equal(st.events[1].online, false);
  });

  it('persists across a fresh require (reads from disk)', () => {
    assert.ok(fs.existsSync(monitor._file));
    const raw = JSON.parse(fs.readFileSync(monitor._file, 'utf8'));
    assert.ok(raw.s1.checks >= 4);
  });

  it('surfaces fleet incidents newest-first', () => {
    monitor.record('s2', false, 9000);
    const inc = monitor.incidents({ s1: 'box one', s2: 'box two' });
    assert.ok(inc.length >= 2);
    assert.ok(inc[0].t >= inc[1].t);
    assert.ok(inc.some(i => i.name === 'box two'));
  });

  it('forget removes a server history', () => {
    monitor.forget('s1');
    assert.equal(monitor.stats('s1').checks, 0);
  });
});

describe('parseMetrics', () => {
  it('parses a /proc metrics dump into normalized fields', () => {
    const out = [
      '===LOADAVG===', '0.50 1.00 0.75 1/234 5678',
      '===NPROC===', '4',
      '===MEMINFO===', 'MemTotal:       8000000 kB', 'MemAvailable:   2000000 kB',
      '===DF===', 'Filesystem 1024-blocks Used Available Capacity Mounted',
      '/dev/sda1 100000000 40000000 60000000 40% /',
      '===UPTIME===', '123456.78 987654.32',
    ].join('\n');
    const m = parseMetrics(out);
    assert.deepEqual(m.load, [0.5, 1.0, 0.75]);
    assert.equal(m.cpus, 4);
    assert.equal(m.loadPct, 13);            // 0.5/4 = 12.5 → 13
    assert.equal(m.memPct, 75);             // (1 - 2/8) = 75%
    assert.equal(m.diskPct, 40);            // 40M / 100M
    assert.equal(m.uptimeSec, 123456);
  });
});
