const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { Writable, Readable } = require('stream');

// Create a fake child process
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdin = new Writable({ write(chunk, enc, cb) { cb(); } });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  return proc;
}

// Re-implement spawnRunner inline since it relies on module-scoped vars
// We test the core logic pattern
function spawnRunner(message, onChunk, spawnFn, bin, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';
    let resolved = false;

    function done() {
      if (resolved) return;
      resolved = true;
      try { proc.kill(); } catch (_) {}
      if (output) resolve(output);
      else if (error) resolve(`STDERR: ${error}`);
      else resolve('Agent completed with no output.');
    }

    const proc = spawnFn(bin, args);

    if (bin === 'agent') {
      proc.stdin.write(message + '\n');
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      onChunk(output);
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', () => done());
    proc.on('exit', () => done());
    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });
  });
}

describe('spawnRunner', () => {
  it('resolves with stdout output', async () => {
    const proc = fakeProc();
    const chunks = [];
    const promise = spawnRunner('hello', (c) => chunks.push(c), () => proc, 'agent', []);

    proc.stdout.emit('data', Buffer.from('response part 1'));
    proc.stdout.emit('data', Buffer.from(' part 2'));
    proc.emit('close', 0);

    const result = await promise;
    assert.equal(result, 'response part 1 part 2');
    assert.equal(chunks.length, 2);
  });

  it('resolves with stderr when no stdout', async () => {
    const proc = fakeProc();
    const promise = spawnRunner('hello', () => {}, () => proc, 'agent', []);

    proc.stderr.emit('data', Buffer.from('some error'));
    proc.emit('close', 1);

    const result = await promise;
    assert.equal(result, 'STDERR: some error');
  });

  it('resolves with fallback message when no output at all', async () => {
    const proc = fakeProc();
    const promise = spawnRunner('hello', () => {}, () => proc, 'agent', []);

    proc.emit('close', 0);

    const result = await promise;
    assert.equal(result, 'Agent completed with no output.');
  });

  it('rejects on spawn error', async () => {
    const proc = fakeProc();
    const promise = spawnRunner('hello', () => {}, () => proc, 'agent', []);

    proc.emit('error', new Error('spawn failed'));

    await assert.rejects(promise, { message: 'spawn failed' });
  });

  it('done is idempotent — close + exit both fire', async () => {
    const proc = fakeProc();
    const promise = spawnRunner('hello', () => {}, () => proc, 'agent', []);

    proc.stdout.emit('data', Buffer.from('output'));
    proc.emit('close', 0);
    proc.emit('exit', 0); // second call should be ignored

    const result = await promise;
    assert.equal(result, 'output');
  });

  it('writes message to stdin for agent binary', async () => {
    let written = '';
    const proc = fakeProc();
    proc.stdin = new Writable({
      write(chunk, enc, cb) { written += chunk.toString(); cb(); }
    });

    const promise = spawnRunner('test message', () => {}, () => proc, 'agent', []);

    proc.stdout.emit('data', Buffer.from('ok'));
    proc.emit('close', 0);

    await promise;
    assert.equal(written, 'test message\n');
  });

  it('does not write to stdin for claude binary', async () => {
    let written = '';
    const proc = fakeProc();
    proc.stdin = new Writable({
      write(chunk, enc, cb) { written += chunk.toString(); cb(); }
    });

    const promise = spawnRunner('test', () => {}, () => proc, 'claude', []);

    proc.stdout.emit('data', Buffer.from('ok'));
    proc.emit('close', 0);

    await promise;
    assert.equal(written, '');
  });
});
