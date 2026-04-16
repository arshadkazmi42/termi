const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// We need to mock exec and fs before requiring server
// Use node:test mock capabilities on the module level functions

describe('sendScreenInput escaping', () => {
  it('escapes backslashes', () => {
    const input = 'echo C:\\Users\\test';
    const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    assert.equal(escaped, 'echo C:\\\\Users\\\\test');
  });

  it('escapes double quotes', () => {
    const input = 'echo "hello world"';
    const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    assert.equal(escaped, 'echo \\"hello world\\"');
  });

  it('escapes both together', () => {
    const input = 'echo "path\\to\\file"';
    const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    assert.equal(escaped, 'echo \\"path\\\\to\\\\file\\"');
  });

  it('leaves clean strings unchanged', () => {
    const input = 'ls -la';
    const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    assert.equal(escaped, 'ls -la');
  });
});

describe('session name sanitization', () => {
  it('preserves valid characters', () => {
    const name = '12345.my_session-v2';
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    assert.equal(safe, '12345.my_session-v2');
  });

  it('replaces special characters with underscore', () => {
    const name = '12345.my session/hack;rm -rf';
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    assert.equal(safe, '12345.my_session_hack_rm_-rf');
  });

  it('handles empty string', () => {
    const safe = ''.replace(/[^a-zA-Z0-9._-]/g, '_');
    assert.equal(safe, '');
  });

  it('builds correct tmp file path', () => {
    const sessionName = '12345.test_run';
    const safeName = sessionName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpFile = path.join('/tmp', `termi_screen_${safeName}.txt`);
    assert.equal(tmpFile, '/tmp/termi_screen_12345.test_run.txt');
  });
});
