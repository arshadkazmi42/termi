const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScreenLs } = require('../../server');

describe('parseScreenLs', () => {
  it('parses multiple sessions with mixed status', () => {
    const output = [
      'There are screens on:',
      '\t12345.my_session\t(Attached)',
      '\t67890.background_job\t(Detached)',
      '2 Sockets in /run/screen/S-root.',
    ].join('\n');

    const sessions = parseScreenLs(output);
    assert.equal(sessions.length, 2);

    assert.deepEqual(sessions[0], {
      pid: '12345',
      name: 'my_session',
      fullName: '12345.my_session',
      status: 'attached',
    });

    assert.deepEqual(sessions[1], {
      pid: '67890',
      name: 'background_job',
      fullName: '67890.background_job',
      status: 'detached',
    });
  });

  it('returns empty array when no sessions', () => {
    const output = 'No Sockets found in /run/screen/S-root.\n';
    assert.deepEqual(parseScreenLs(output), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseScreenLs(''), []);
  });

  it('handles session names with dots and dashes', () => {
    const output = '\t11111.my-app.v2.prod\t(Detached)\n';
    const sessions = parseScreenLs(output);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, 'my-app.v2.prod');
    assert.equal(sessions[0].pid, '11111');
  });

  it('handles multi-attached status text', () => {
    const output = '\t99999.test_run\t(Multi, Attached)\n';
    const sessions = parseScreenLs(output);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'attached');
  });

  it('ignores malformed lines', () => {
    const output = [
      'There are screens on:',
      'garbage line here',
      '\t12345.valid_session\t(Attached)',
      '   not a session line',
      '',
    ].join('\n');

    const sessions = parseScreenLs(output);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, 'valid_session');
  });

  it('handles single session', () => {
    const output = [
      'There is a screen on:',
      '\t55555.claude_run\t(Detached)',
      '1 Socket in /run/screen/S-root.',
    ].join('\n');

    const sessions = parseScreenLs(output);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].fullName, '55555.claude_run');
    assert.equal(sessions[0].status, 'detached');
  });
});
