import test from 'node:test';
import assert from 'node:assert/strict';
import { readChannel, saveChannel } from '../public/channel-storage.js';
import { restoreSnapshot } from '../snapshots.mjs';
import { active, addEvent, initialState, nominate, moderate } from '../model.mjs';

function fixture(channelId = '101') {
  const state = initialState();
  active(state).channel = channelId;
  addEvent(active(state), { type: 'goal', text: 'Saved goal' });
  return { version: 1, channelId, overlayKey: 'a'.repeat(64), state };
}
function storage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
test('browser backups stay per channel and exclude unhydrated state, guest data, and credentials', () => {
  const local = storage(),
    backup = fixture();
  const connected = {
    authenticated: true,
    channelId: '101',
    needsRestore: false,
    backup,
    status: { token: 'never-save-this', login: 'streamer' },
  };
  saveChannel(connected, local);
  assert.deepEqual(readChannel('101', local), backup);
  assert.equal(readChannel('202', local), null);
  saveChannel({ ...connected, needsRestore: true, backup: fixture() }, local);
  saveChannel({ ...connected, authenticated: false, backup: fixture() }, local);
  assert.deepEqual(readChannel('101', local), backup);
  assert.ok(!local.getItem('supra:channel:101').includes('never-save-this'));
  const other = fixture('202');
  saveChannel({ ...connected, channelId: '202', backup: other }, local);
  assert.deepEqual(readChannel('101', local), backup);
  assert.deepEqual(readChannel('202', local), other);
});
test('corrupt browser data, unavailable storage, and quota errors surface without deleting prior saves', () => {
  const local = storage();
  local.setItem('supra:channel:101', '{broken');
  assert.throws(() => readChannel('101', local));
  assert.equal(local.getItem('supra:channel:101'), '{broken');
  const unavailable = {
    getItem() {
      throw new Error('Storage blocked');
    },
  };
  assert.throws(() => readChannel('101', unavailable), /blocked/);
  const backup = fixture();
  saveChannel({ authenticated: true, channelId: '101', backup }, local);
  const prior = local.getItem('supra:channel:101');
  const full = {
    getItem: local.getItem,
    setItem() {
      throw new Error('Quota exceeded');
    },
  };
  active(backup.state).title = 'New title';
  assert.throws(
    () => saveChannel({ authenticated: true, channelId: '101', backup }, full),
    /Quota/,
  );
  assert.equal(local.getItem('supra:channel:101'), prior);
});
test('restoration validates identity and structure, preserves pending review, and drops unsupported fields', () => {
  const snapshot = fixture();
  const session = active(snapshot.state);
  const pending = nominate(session, { text: 'Pending secret', author: 'Viewer', authorId: '303' });
  const approved = nominate(session, { text: 'Approved story', author: 'Viewer', authorId: '303' });
  moderate(session, approved.id, 'approve', 'joke');
  snapshot.state.token = 'never-restore';
  session.token = 'never-restore';
  const restored = restoreSnapshot(snapshot, '101');
  assert.equal(
    active(restored).nominations.find((item) => item.id === pending.id).status,
    'pending',
  );
  assert.equal(active(restored).events.at(-1).at, approved.at);
  assert.ok(!JSON.stringify(restored).includes('never-restore'));
  assert.throws(() => restoreSnapshot(snapshot, '202'), /different/);
  for (const mutate of [
    (value) => {
      active(value.state).channel = '202';
    },
    (value) => {
      active(value.state).demo = true;
    },
    (value) => {
      active(value.state).events[0].type = 'invalid';
    },
    (value) => {
      active(value.state).startedAt = Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.state.activeId = 'missing';
    },
    (value) => {
      active(value.state).events.push(active(value.state).events[0]);
    },
  ]) {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    assert.throws(() => restoreSnapshot(invalid, '101'));
  }
});
