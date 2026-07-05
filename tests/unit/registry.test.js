const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the registry at a throwaway data dir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termi-reg-'));
process.env.DATA_DIR = tmpDir;
const registry = require('../../lib/registry');

const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfakekeymaterialfortest\n-----END OPENSSH PRIVATE KEY-----';

describe('registry', () => {
  before(() => registry.setSecret('test-secret'));
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('encrypts and decrypts a secret round-trip', () => {
    const enc = registry._encrypt('hello world');
    assert.notEqual(enc.enc, 'hello world');
    assert.equal(registry._decrypt(enc), 'hello world');
  });

  it('rejects non-key material', () => {
    assert.throws(() => registry.addKey({ name: 'bad', privateKey: 'not a key' }), /valid private key/);
  });

  it('stores keys encrypted and lists without secrets', () => {
    const { id } = registry.addKey({ name: 'test key', privateKey: FAKE_KEY });
    const listed = registry.listKeys().find(k => k.id === id);
    assert.equal(listed.name, 'test key');
    assert.equal(listed.privateKey, undefined);
    assert.equal(listed.enc, undefined);
    // On-disk file must not contain the plaintext key
    const raw = fs.readFileSync(registry.REG_FILE, 'utf8');
    assert.ok(!raw.includes('fakekeymaterial'));
    // But material is recoverable
    assert.ok(registry.getKeyMaterial(id).privateKey.includes('fakekeymaterial'));
    assert.equal(registry.getKeyMaterial(id).passphrase, undefined);
  });

  it('stores and recovers a key passphrase, encrypted', () => {
    const { id } = registry.addKey({ name: 'pp key', privateKey: FAKE_KEY, passphrase: 'sekret-pass' });
    const raw = fs.readFileSync(registry.REG_FILE, 'utf8');
    assert.ok(!raw.includes('sekret-pass'));
    assert.equal(registry.getKeyMaterial(id).passphrase, 'sekret-pass');
  });

  it('updateKey can add a passphrase without replacing material', () => {
    const { id } = registry.addKey({ name: 'late pp', privateKey: FAKE_KEY });
    assert.equal(registry.getKeyMaterial(id).passphrase, undefined);
    registry.updateKey(id, { passphrase: 'added-later' });
    const m = registry.getKeyMaterial(id);
    assert.equal(m.passphrase, 'added-later');
    assert.ok(m.privateKey.includes('fakekeymaterial')); // material untouched
  });

  it('updateKey renames and replaces material, clearing stale passphrase', () => {
    const { id } = registry.addKey({ name: 'old name', privateKey: FAKE_KEY, passphrase: 'old-pass' });
    registry.updateKey(id, { name: 'new name', privateKey: FAKE_KEY.replace('fakekey', 'newkey00') });
    assert.equal(registry.listKeys().find(k => k.id === id).name, 'new name');
    const m = registry.getKeyMaterial(id);
    assert.ok(m.privateKey.includes('newkey00material'));
    assert.equal(m.passphrase, undefined); // replaced material, no passphrase given
    assert.throws(() => registry.updateKey(id, { privateKey: 'junk' }), /valid private key/);
  });

  it('validates server input', () => {
    const { id: keyId } = registry.addKey({ name: 'k2', privateKey: FAKE_KEY });
    assert.throws(() => registry.addServer({ host: 'bad host!', user: 'root', keyId }), /Invalid host/);
    assert.throws(() => registry.addServer({ host: 'ok.example.com', port: 99999, user: 'root', keyId }), /Invalid port/);
    assert.throws(() => registry.addServer({ host: 'ok.example.com', user: 'root; rm -rf /', keyId }), /Invalid user/);
    assert.throws(() => registry.addServer({ host: 'ok.example.com', user: 'root', keyId: 'key_nope' }), /Pick an SSH key/);
    const srv = registry.addServer({ name: 'prod', host: 'ok.example.com', port: 22, user: 'root', keyId });
    assert.ok(srv.id.startsWith('srv_'));
    assert.equal(registry.getServer(srv.id).host, 'ok.example.com');
  });

  it('stores a password-auth server with the password encrypted', () => {
    const srv = registry.addServer({ name: 'pw box', host: 'pw.example.com', user: 'root', authType: 'password', password: 'hunter2secret' });
    assert.equal(srv.authType, 'password');
    assert.equal(srv.keyId, undefined);
    const raw = fs.readFileSync(registry.REG_FILE, 'utf8');
    assert.ok(!raw.includes('hunter2secret')); // never on disk in plaintext
    assert.equal(registry.getServerPassword(srv.id), 'hunter2secret');
    // listServers exposes authType but never the password
    const listed = registry.listServers().find(s => s.id === srv.id);
    assert.equal(listed.authType, 'password');
    assert.equal(listed.pw, undefined);
    registry.removeServer(srv.id);
  });

  it('password server requires a password on add', () => {
    assert.throws(() => registry.addServer({ host: 'x.example.com', user: 'root', authType: 'password' }), /Password required/);
  });

  it('editing a password server keeps the old password when none given', () => {
    const srv = registry.addServer({ name: 'keep pw', host: 'k.example.com', user: 'root', authType: 'password', password: 'orig-pass' });
    registry.updateServer(srv.id, { name: 'renamed pw' });
    assert.equal(registry.getServerPassword(srv.id), 'orig-pass');
    registry.updateServer(srv.id, { authType: 'password', password: 'new-pass' });
    assert.equal(registry.getServerPassword(srv.id), 'new-pass');
    registry.removeServer(srv.id);
  });

  it('switching a server from password to key clears the stored password', () => {
    const { id: keyId } = registry.addKey({ name: 'switch key', privateKey: FAKE_KEY });
    const srv = registry.addServer({ name: 'switcher', host: 's.example.com', user: 'root', authType: 'password', password: 'temp' });
    registry.updateServer(srv.id, { authType: 'key', keyId });
    assert.equal(registry.getServerPassword(srv.id), undefined);
    assert.equal(registry.getServer(srv.id).authType, 'key');
    registry.removeServer(srv.id);
    registry.removeKey(keyId);
  });

  it('refuses to delete a key still used by a server', () => {
    const { id: keyId } = registry.addKey({ name: 'k3', privateKey: FAKE_KEY });
    const srv = registry.addServer({ name: 'box', host: 'h.example.com', user: 'root', keyId });
    assert.throws(() => registry.removeKey(keyId), /used by/);
    registry.removeServer(srv.id);
    registry.removeKey(keyId); // now fine
    assert.ok(!registry.listKeys().some(k => k.id === keyId));
  });

  it('re-pins host key when host changes', () => {
    const { id: keyId } = registry.addKey({ name: 'k4', privateKey: FAKE_KEY });
    const srv = registry.addServer({ name: 'pin', host: 'a.example.com', user: 'root', keyId });
    registry.pinHostKey(srv.id, 'SHA256:abc');
    assert.equal(registry.getServer(srv.id).hostKeyFp, 'SHA256:abc');
    registry.updateServer(srv.id, { host: 'b.example.com' });
    assert.equal(registry.getServer(srv.id).hostKeyFp, null);
    registry.removeServer(srv.id);
  });
});
