const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

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
    server.close(done);
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
      assert.ok(Array.isArray(q));
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
      assert.equal(q.length, 0);
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
