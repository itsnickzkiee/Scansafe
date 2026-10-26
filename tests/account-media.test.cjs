'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'assets/account-media.js'), 'utf8');
const uid = '22222222-2222-2222-2222-222222222222';
const file = (type = 'image/jpeg', size = 120, bytes = [255, 216, 255, 224]) => ({ type, size, arrayBuffer: async () => Uint8Array.from(bytes).buffer, slice() { return this; } });
function fixture() {
  const calls = [], state = { sessionUid: uid, context: { userId: uid, role: 'evacuee' }, putError: null, rpcError: null, uploadWait: null, rpcWait: null };
  const sb = {
    auth: { getSession: async () => ({ data: { session: state.sessionUid ? { user: { id: state.sessionUid } } : null } }) },
    storage: { from: bucket => ({
      upload: async (p, f, config) => { calls.push({ op: 'upload', bucket, path: p, config }); if (state.uploadWait) await state.uploadWait; return { error: state.putError }; },
      remove: async paths => { calls.push({ op: 'remove', paths }); return { error: null }; },
      createSignedUrl: async p => { calls.push({ op: 'signedUrl', path: p }); return { data: { signedUrl: 'https://example.test/private/' + p } }; }
    }) },
    rpc: async (name, args) => {
      calls.push({ op: 'rpc', name, args }); if (state.rpcWait) await state.rpcWait;
      if (state.rpcError) return { error: state.rpcError };
      const p = args?.p_path;
      return { data: { owner_id: state.responseUid || state.sessionUid, evacuee_id: 1,
        profile_photo: args?.p_kind === 'profile' ? { path: p } : null,
        valid_id: args?.p_kind === 'valid-id' ? { path: p } : null, previous_path: state.previousPath } };
    }
  };
  const document = { querySelectorAll: () => [], getElementById: () => null };
  const window = { crypto: { randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
  vm.runInNewContext(source, { window, document, URL, Uint8Array, console, Date });
  const api = window.ScanSafeMedia;
  return { api, state, calls, init: () => api.init({ getClient: () => sb, getContext: () => state.context }) };
}
test('registration ID upload uses signed-in owner, actual Storage and confirmed metadata RPC', async () => {
  const f = fixture(); f.state.context = {}; await f.init();
  const result = await f.api.uploadRegistrationId({ file: file(), ownerId: uid });
  assert.equal(result.valid_id.path, `${uid}/valid-id/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`);
  const put = f.calls.find(c => c.op === 'upload');
  assert.equal(put.bucket, 'scansafe-account-media'); assert.equal(put.config.upsert, false);
  assert.equal(f.calls.filter(c => c.name === 'save_scansafe_account_media').length, 1);
});
test('wrong MIME, oversized or spoofed image stops before upload', async () => {
  const f = fixture(); await f.init();
  for (const bad of [file('application/pdf'), file('image/jpeg', 2097153), file('image/png', 120, [255, 216, 255])]) {
    await assert.rejects(f.api.uploadProfilePhoto({ file: bad, ownerId: uid }), /image|MB/);
  }
  assert.equal(f.calls.filter(c => c.op === 'upload').length, 0);
});
test('no session or changed expected owner cannot upload', async () => {
  const f = fixture(); await f.init(); f.state.sessionUid = null;
  await assert.rejects(f.api.uploadProfilePhoto({ file: file(), ownerId: uid }), /Sign in/);
  f.state.sessionUid = 'other-owner';
  await assert.rejects(f.api.uploadProfilePhoto({ file: file(), ownerId: uid }), /account changed/);
  assert.equal(f.calls.filter(c => c.op === 'upload').length, 0);
});
test('Storage failure never claims metadata success and best-effort cleans the unused object', async () => {
  const f = fixture(); await f.init(); f.state.putError = { message: 'Network failed' };
  await assert.rejects(f.api.uploadRegistrationId({ file: file(), ownerId: uid }), /Network failed/);
  assert.equal(f.calls.filter(c => c.name === 'save_scansafe_account_media').length, 0);
  assert.equal(f.calls.filter(c => c.op === 'remove').length, 1);
});
test('metadata failure is visible and does not return a false successful upload', async () => {
  const f = fixture(); await f.init(); f.state.rpcError = { message: 'Audit unavailable' };
  await assert.rejects(f.api.uploadRegistrationId({ file: file(), ownerId: uid }), /Audit unavailable/);
  assert.equal(f.calls.filter(c => c.op === 'remove').length, 1);
});
test('unconfirmed owner metadata never produces a successful upload message', async () => {
  const f = fixture(); await f.init(); f.state.responseUid = 'foreign';
  await assert.rejects(f.api.uploadRegistrationId({ file: file(), ownerId: uid }), /could not be confirmed/);
});
test('account switch while uploading blocks finalizing and discards stale result', async () => {
  const f = fixture(); await f.init(); let release;
  f.state.uploadWait = new Promise(resolve => { release = resolve; });
  const result = f.api.uploadProfilePhoto({ file: file(), ownerId: uid });
  while (!f.calls.some(c => c.op === 'upload')) await new Promise(resolve => setImmediate(resolve));
  f.state.sessionUid = 'other-owner'; f.api.reset(); release();
  await assert.rejects(result, /account changed/);
  assert.equal(f.calls.filter(c => c.name === 'save_scansafe_account_media').length, 0);
});
test('superseded object cleanup happens only after finalization succeeds', async () => {
  const f = fixture(); await f.init(); f.state.previousPath = `${uid}/profile/old.jpg`;
  await f.api.uploadProfilePhoto({ file: file(), ownerId: uid });
  const finalize = f.calls.findIndex(c => c.name === 'save_scansafe_account_media');
  const cleanup = f.calls.findIndex(c => c.op === 'remove');
  assert.ok(cleanup > finalize); assert.equal(f.calls[cleanup].paths[0], f.state.previousPath);
});
test('refresh coalesces calls and refuses media belonging to a different account', async () => {
  const f = fixture(); let release; f.state.rpcWait = new Promise(resolve => { release = resolve; }); f.state.responseUid = 'foreign';
  const initial = f.init(); const again = f.api.refresh(); release();
  assert.equal(await initial, null); assert.equal(await again, null);
  assert.equal(f.calls.filter(c => c.name === 'get_my_scansafe_media').length, 1);
  assert.equal(f.calls.filter(c => c.op === 'signedUrl').length, 0);
});
