const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Test queue logic in isolation
describe('queue operations', () => {
  let queue;

  beforeEach(() => {
    queue = [];
  });

  it('adds items with id and message', () => {
    const item = { id: 1, message: 'hello' };
    queue.push(item);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].message, 'hello');
  });

  it('removes item by id', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
      { id: 3, message: 'third' },
    ];
    queue = queue.filter(i => i.id !== 2);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].id, 1);
    assert.equal(queue[1].id, 3);
  });

  it('remove with non-existent id does nothing', () => {
    queue = [{ id: 1, message: 'first' }];
    queue = queue.filter(i => i.id !== 999);
    assert.equal(queue.length, 1);
  });

  it('moves item up', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
      { id: 3, message: 'third' },
    ];

    const idx = queue.findIndex(i => i.id === 2);
    if (idx > 0) {
      [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
    }

    assert.equal(queue[0].id, 2);
    assert.equal(queue[1].id, 1);
    assert.equal(queue[2].id, 3);
  });

  it('move up first item is no-op', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
    ];

    const idx = queue.findIndex(i => i.id === 1);
    if (idx > 0) {
      [queue[idx - 1], queue[idx]] = [queue[idx], queue[idx - 1]];
    }

    assert.equal(queue[0].id, 1);
    assert.equal(queue[1].id, 2);
  });

  it('moves item down', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
      { id: 3, message: 'third' },
    ];

    const idx = queue.findIndex(i => i.id === 2);
    if (idx < queue.length - 1) {
      [queue[idx], queue[idx + 1]] = [queue[idx + 1], queue[idx]];
    }

    assert.equal(queue[0].id, 1);
    assert.equal(queue[1].id, 3);
    assert.equal(queue[2].id, 2);
  });

  it('move down last item is no-op', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
    ];

    const idx = queue.findIndex(i => i.id === 2);
    if (idx < queue.length - 1) {
      [queue[idx], queue[idx + 1]] = [queue[idx + 1], queue[idx]];
    }

    assert.equal(queue[0].id, 1);
    assert.equal(queue[1].id, 2);
  });

  it('clears all items', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
    ];
    queue = [];
    assert.equal(queue.length, 0);
  });

  it('shift removes first item', () => {
    queue = [
      { id: 1, message: 'first' },
      { id: 2, message: 'second' },
    ];
    const next = queue.shift();
    assert.equal(next.id, 1);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, 2);
  });
});
