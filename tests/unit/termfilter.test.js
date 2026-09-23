const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { altScreenFilter, cleanHardcopy } = require('../../lib/termfilter');

describe('altScreenFilter', () => {
  it('drops alternate-screen switches, keeps everything else', () => {
    const f = altScreenFilter();
    const out = f('\x1b[!p\x1b[?3;4l\x1b[?1049h\x1b[22;0;0t\x1b[H\x1b[2Jhello\x1b[?1049l\x1b[?47h\x1b[?1047l');
    assert.equal(out, '\x1b[!p\x1b[?3;4l\x1b[22;0;0t\x1b[H\x1b[2Jhello');
  });

  it('handles a sequence split across chunks', () => {
    const f = altScreenFilter();
    assert.equal(f('abc\x1b[?10'), 'abc');       // prefix held back
    assert.equal(f('49hdef'), 'def');             // completed and dropped
    assert.equal(f('x\x1b'), 'x');
    assert.equal(f('[?47lrest'), 'rest');
  });

  it('releases a held prefix that turns out to be something else', () => {
    const f = altScreenFilter();
    assert.equal(f('a\x1b['), 'a');
    assert.equal(f('31mred'), '\x1b[31mred');
    assert.equal(f('b\x1b[?1'), 'b');
    assert.equal(f('h'), '\x1b[?1h');
  });

  it('drops mouse-tracking modes, keeps unrelated private modes', () => {
    const f = altScreenFilter();
    assert.equal(f('\x1b[?2004h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1015l'), '\x1b[?2004h\x1b[?25l');
    assert.equal(f('\x1b[?100'), '');
    assert.equal(f('3h!'), '!');
  });
});

describe('cleanHardcopy', () => {
  it('trims trailing spaces and blank padding rows', () => {
    const raw = '\n\nline one   \nline two\t\n\n\n   \n';
    assert.equal(cleanHardcopy(raw), 'line one\nline two');
  });
  it('keeps interior blank lines', () => {
    assert.equal(cleanHardcopy('a\n\nb\n'), 'a\n\nb');
  });
  it('handles empty input', () => {
    assert.equal(cleanHardcopy(''), '');
    assert.equal(cleanHardcopy(undefined), '');
  });
});
