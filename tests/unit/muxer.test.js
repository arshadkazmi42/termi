const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../lib/muxer');

describe('muxer: backend selection', () => {
  it('guesses screen for a "<pid>.<name>" identity', () => {
    assert.equal(m.guess('12345.work').name, 'screen');
    assert.equal(m.guess('1.x').name, 'screen');
  });
  it('guesses tmux for a plain name', () => {
    assert.equal(m.guess('work').name, 'tmux');
    assert.equal(m.guess('my-session').name, 'tmux');
    assert.equal(m.guess('').name, 'tmux');
  });
  it('byName resolves known backends and nothing else', () => {
    assert.equal(m.byName('screen'), m.screen);
    assert.equal(m.byName('tmux'), m.tmux);
    assert.equal(m.byName('nope'), null);
    assert.equal(m.byName(undefined), null);
  });
  it('picks tmux for new sessions when available, else screen', () => {
    assert.equal(m.pickCreateBackend({ hasTmux: true }).name, 'tmux');
    assert.equal(m.pickCreateBackend({ hasTmux: false }).name, 'screen');
    assert.equal(m.pickCreateBackend(null).name, 'screen');
  });
});

describe('muxer: screen backend', () => {
  const s = m.screen;
  it('parses screen -ls output (pid is the identity)', () => {
    const out = '\t12345.work\t(01/02/2026 10:00:00 AM)\t(Detached)\n\t999.live\t(Attached)\n';
    const sessions = s.parseList(out);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0], { id: '12345', pid: '12345', name: 'work', fullName: '12345.work', status: 'detached', backend: 'screen' });
    assert.equal(sessions[1].status, 'attached');
    assert.equal(sessions[1].id, '999');
  });
  it('ignores non-session lines', () => {
    assert.equal(s.parseList('There is a screen on:\nNo Sockets found.\n').length, 0);
  });
  it('builds attach/create/rename/history commands', () => {
    assert.deepEqual(s.attachSpawn('12345.work'), { bin: 'screen', args: ['-A', '-x', '12345.work'] });
    assert.equal(s.attachRemoteCmd('12345.work'), 'screen -A -x 12345.work');
    assert.deepEqual(s.watchSpawn('12345'), { bin: 'screen', args: ['-x', '12345'] });
    assert.equal(s.createCmd('terminal'), 'screen -dmS terminal');
    assert.equal(s.renameCmd('12345.work', 'build'), 'screen -S 12345.work -X sessionname build');
    assert.equal(s.historyMode, 'file');
    assert.match(s.historyCmd('12345.work', { tmp: '/tmp/x' }), /hardcopy -h \/tmp\/x$/);
  });
  it('externalSize is true and detaches with Ctrl-A d', () => {
    assert.equal(s.externalSize, true);
    assert.equal(s.detachKeys, '\x01d');
    assert.match(s.windowSizeCmd('12345.work', 80, 24), /screen -S 12345.work -X width -w 80 24/);
    assert.equal(s.windowSizeCmd('bad name; rm -rf /', 80, 24), null);
  });
});

describe('muxer: tmux backend', () => {
  const t = m.tmux;
  it('parses tab-separated tmux list output (name is the identity)', () => {
    const sessions = t.parseList('alpha\tattached\nbeta\tdetached\n');
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0], { id: 'alpha', pid: 'alpha', name: 'alpha', fullName: 'alpha', status: 'attached', backend: 'tmux' });
    assert.equal(sessions[1].status, 'detached');
  });
  it('ignores blank / malformed lines', () => {
    assert.equal(t.parseList('\n\nnotabhere\n').length, 0);
  });
  it('uses a dedicated socket, not the user\'s default tmux', () => {
    assert.match(t.listCmd, /^tmux -L termi /);
    assert.match(t.createCmd('x'), /tmux -L termi new-session/);
    assert.match(t.renameCmd('a', 'b'), /tmux -L termi rename-session/);
  });
  it('sets truecolor + history-limit before creating the session', () => {
    const cmd = t.createCmd('mysess', { cols: 100, rows: 30, scrollback: 9000 });
    assert.match(cmd, /terminal-overrides ',\*:Tc'/);
    assert.match(cmd, /set -g history-limit 9000/);
    // history-limit set before new-session (so the first pane gets it)
    assert.ok(cmd.indexOf('history-limit') < cmd.indexOf('new-session'));
    assert.match(cmd, /new-session -d -s 'mysess' -x 100 -y 30/);
  });
  it('reads history straight from stdout (capture-pane), no tmp file', () => {
    assert.equal(t.historyMode, 'stdout');
    assert.match(t.historyCmd('sess', { lines: 5000 }), /capture-pane -pt 'sess' -S -5000$/);
  });
  it('pins window size per-session (resize-window) and needs no detach key', () => {
    assert.equal(t.externalSize, true);
    assert.equal(t.windowSizeCmd('sess', 80, 24), "tmux -L termi resize-window -t 'sess' -x 80 -y 24");
    assert.equal(t.windowSizeCmd('bad name; rm', 80, 24), null);
    assert.equal(t.windowSizeCmd('sess', 0, 24), null); // out of bounds
    assert.match(t.createCmd('sess'), /set-option -t 'sess' window-size manual/);
    assert.equal(t.detachKeys, ''); // daemon keeps the session when the client pty dies
  });
  it('attach script forces truecolor and exec-attaches an existing session', () => {
    const script = t.attachSpawn('mysess').args[1];
    assert.match(script, /default-terminal tmux-256color/);
    assert.match(script, /exec tmux -L termi attach -t 'mysess'/);
    assert.match(script, /tmux is not installed/); // graceful guard
  });
  it('single-quotes session names so they cannot break out of the shell', () => {
    const script = t.attachSpawn("a'b").args[1];
    assert.match(script, /attach -t 'a'\\''b'/);
  });
});
