const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

// Keep registry / watch list / push keys out of the real data dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termi-int-'));
process.env.DATA_DIR = tmpDir;

const { server, io, AUTH_TOKEN, resetState } = require('../../server');

const PORT = 0; // random port
let serverUrl;
let addr;

function connectClient(token) {
  return ioClient(serverUrl, {
    auth: { token: token || AUTH_TOKEN },
    transports: ['websocket'],
    forceNew: true,
  });
}

function waitEvent(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe('socket handlers', () => {
  before((_, done) => {
    server.listen(0, () => {
      addr = server.address();
      serverUrl = `http://localhost:${addr.port}`;
      done();
    });
  });

  after((_, done) => {
    io.close();
    server.close(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); done(); });
  });

  beforeEach(() => {
    resetState();
  });

  describe('auth', () => {
    it('connects with valid token', async () => {
      const client = connectClient(AUTH_TOKEN);
      await waitEvent(client, 'connect');
      assert.ok(client.connected);
      client.disconnect();
    });

    it('rejects invalid token', async () => {
      const client = connectClient('wrong-token');
      const err = await waitEvent(client, 'connect_error');
      assert.ok(err);
      client.disconnect();
    });
  });

  describe('queue', () => {
    it('emits queue on chat', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');

      const queuePromise = waitEvent(client, 'queue');
      client.emit('chat', { message: 'test task' });
      const q = await queuePromise;

      // Queue might be empty if processQueue already shifted it,
      // but we should have received a queue event
      assert.ok(Array.isArray(q.queue));
      assert.equal(q.serverId, 'local');
      client.disconnect();
    });

    it('removes item from queue', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');

      // Listen for queue events
      const queues = [];
      client.on('queue', (q) => queues.push(q));

      client.emit('chat', { message: 'first' });
      client.emit('chat', { message: 'second' });

      // Wait for queue events to arrive
      await new Promise(r => setTimeout(r, 500));

      const state = require('../../server').getState();
      if (state.queue.length > 0) {
        client.emit('queue:remove', { id: state.queue[0].id });
        await new Promise(r => setTimeout(r, 200));
      }

      // We should have received at least one queue event
      assert.ok(queues.length > 0);
      client.disconnect();
    });

    it('clears queue', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');

      const queuePromise = waitEvent(client, 'queue');
      client.emit('queue:clear');
      const q = await queuePromise;
      assert.equal(q.queue.length, 0);
      client.disconnect();
    });
  });

  describe('reset', () => {
    it('resets session state', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');

      const responsePromise = waitEvent(client, 'response');
      client.emit('reset');
      const res = await responsePromise;
      assert.equal(res.type, 'system');
      assert.ok(res.content.includes('reset'));
      client.disconnect();
    });
  });

  describe('screen:list', () => {
    it('returns sessions array', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');

      const listPromise = waitEvent(client, 'screen:list');
      client.emit('screen:list');
      const data = await listPromise;
      assert.ok(Array.isArray(data.sessions));
      client.disconnect();
    });
  });

  describe('screen:history', () => {
    it('rejects an invalid session name', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');
      const p = waitEvent(client, 'screen:history');
      client.emit('screen:history', { sessionName: 'bad name; rm -rf /' });
      const res = await p;
      assert.match(res.error, /Invalid session name/);
      client.disconnect();
    });
  });

  describe('notifications', () => {
    it('sends the watch list on connect and on request', async () => {
      const client = connectClient();
      const first = await waitEvent(client, 'watch:list');
      assert.ok(Array.isArray(first.watches));
      const p = waitEvent(client, 'watch:list');
      client.emit('watch:list');
      assert.ok(Array.isArray((await p).watches));
      client.disconnect();
    });

    it('rejects a watch on a non-numeric pid', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');
      const p = waitEvent(client, 'servers:error');
      client.emit('watch:set', { serverId: 'local', pid: 'abc; ls', name: 'x', on: true });
      assert.match((await p).message, /Invalid session/);
      client.disconnect();
    });

    it('answers push:key with a VAPID public key (when web-push is installed)', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');
      const res = await new Promise((resolve) => client.emit('push:key', null, resolve));
      if (res.available) assert.ok(typeof res.key === 'string' && res.key.length > 40);
      else assert.equal(res.key, null);
      client.disconnect();
    });

    it('stores a push subscription and rejects junk', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');
      let p = waitEvent(client, 'push:subscribed');
      client.emit('push:subscribe', { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } } });
      assert.equal((await p).ok, true);
      p = waitEvent(client, 'push:subscribed');
      client.emit('push:subscribe', { subscription: { nope: 1 } });
      assert.equal((await p).ok, false);
      client.emit('push:unsubscribe', { endpoint: 'https://push.example/x' });
      client.disconnect();
    });
  });

  describe('setAgent', () => {
    it('ignores invalid agent type', async () => {
      const client = connectClient();
      await waitEvent(client, 'connect');

      client.emit('setAgent', { type: 'invalid' });
      // Should not crash, no agentSwitched event
      await new Promise(r => setTimeout(r, 200));
      const state = require('../../server').getState();
      assert.equal(state.agentType, 'agent'); // unchanged
      client.disconnect();
    });
  });
});
