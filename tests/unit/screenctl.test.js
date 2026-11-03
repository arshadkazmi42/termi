const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { windowSize, windowSizeCmd, SAFE_SESSION } = require('../../lib/screenctl');

describe('windowSizeCmd', () => {
  it('builds the width -w command for a pid.name session', () => {
    assert.equal(windowSizeCmd('12345.my-sess_1', 48, 30), 'screen -S 12345.my-sess_1 -X width -w 48 30');
  });
  it('truncates fractional sizes and accepts numeric strings', () => {
    assert.equal(windowSizeCmd('1.a', '47.9', 20.2), 'screen -S 1.a -X width -w 47 20');
  });
  it('refuses unsafe session names', () => {
    assert.equal(windowSizeCmd('1.a; rm -rf /', 80, 24), null);
    assert.equal(windowSizeCmd('1.a$(id)', 80, 24), null);
    assert.equal(windowSizeCmd('', 80, 24), null);
    assert.equal(windowSizeCmd(undefined, 80, 24), null);
  });
  it('refuses sizes a terminal cannot have', () => {
    assert.equal(windowSizeCmd('1.a', 0, 24), null);
    assert.equal(windowSizeCmd('1.a', 80, NaN), null);
    assert.equal(windowSizeCmd('1.a', 'x', 24), null);
    assert.equal(windowSizeCmd('1.a', 5000, 24), null);
    assert.equal(windowSizeCmd('1.a', 80, 1), null);
  });
});

describe('windowSize', () => {
  it('clamps nothing, only validates', () => {
    assert.deepEqual(windowSize(10, 3), { cols: 10, rows: 3 });
    assert.deepEqual(windowSize(1000, 500), { cols: 1000, rows: 500 });
    assert.equal(windowSize(9, 3), null);
    assert.equal(windowSize(1001, 3), null);
  });
  it('shares the session-name rule with the server', () => {
    assert.ok(SAFE_SESSION.test('3212339.termi'));
    assert.ok(!SAFE_SESSION.test('a b'));
  });
});
