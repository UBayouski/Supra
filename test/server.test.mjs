import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createServerApp } from '../server.mjs';
import { memoryStore } from '../store.mjs';
import { active, addEvent } from '../model.mjs';
const createApp = options => createServerApp({ publicUrl: '', host: '127.0.0.1', ...options });

test('private guest studio, moderation, overlay, and archives', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'supra-test-'));
  const app = await createApp({ port: 0, directory, clientId: '' });
  const origin = await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = await fetch(`${origin}/api/state`);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  await initial.json();
  const get = path => fetch(origin + path, { headers: { Cookie: cookie } });
  const post = (path, data, requestOrigin = origin) => fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin, Cookie: cookie }, body: JSON.stringify(data),
  });
  for (const path of ['/', '/app.js', '/style.css', '/favicon.svg', '/overlay', '/overlay.js', '/channel-storage.js']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    await response.text();
  }
  assert.equal((await post('/api/action', { action: 'demo' }, 'https://other.example')).status, 403);
  let response = await post('/api/action', { action: 'add', type: 'goal', text: 'A real goal' });
  let state = await response.json();
  assert.equal(state.recap.goal.text, 'A real goal');
  const originalId = state.session.id;
  response = await post('/api/action', { action: 'nominate', text: 'Private pending text', author: 'Viewer' });
  state = await response.json();
  const nomination = state.session.nominations[0];
  let overlay = await (await get('/api/overlay')).text();
  assert.ok(!overlay.includes('Private pending text'));
  response = await post('/api/action', { action: 'moderate', id: nomination.id, decision: 'approve', type: 'joke' });
  assert.equal(response.status, 200);
  overlay = await (await get('/api/overlay')).json();
  assert.equal(overlay.recap.sources.find(item => item.type === 'joke').text, 'Private pending text');
  response = await post('/api/action', { action: 'demo' });
  state = await response.json();
  assert.equal(state.session.demo, true);
  assert.equal(state.sessions.length, 2);
  response = await post('/api/simulate', { message: '!catchup', moderator: false });
  state = await response.json();
  assert.equal(state.lastCatchup.author, 'demo_viewer');
  assert.equal(state.replies, false);
  assert.equal((await post('/api/replies', { enabled: true })).status, 400);
  assert.equal((await post('/api/simulate', { message: '!goal Forged', moderator: false })).status, 400);
  const exportResponse = await get('/api/export');
  assert.equal(exportResponse.status, 200);
  assert.ok(exportResponse.headers.get('content-disposition').includes('attachment'));
  const exported = await exportResponse.json();
  assert.equal(exported.sessions.find(item => item.id === originalId).events.length, 2);
  assert.equal(state.authenticated, false);
  await assert.rejects(readFile(join(directory, 'state.json')), { code: 'ENOENT' });
  assert.equal((await post('/api/action', { action: 'switch', id: originalId })).status, 200);
  assert.equal((await post('/api/simulate', { message: '!catchup' })).status, 400);
});

test('memory changes are transactional and failed changes do not leak', async () => {
  const store = memoryStore();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.change(state => addEvent(active(state), { type: 'milestone', text: `Moment ${i}` }))));
  assert.equal(active(store.get()).events.length, 20);
  await assert.rejects(store.change(state => { active(state).title = 'Should not persist'; throw new Error('Rejected'); }));
  assert.equal(active(store.get()).title, 'Untitled stream');
  const copy = store.get(); active(copy).events.length = 0;
  assert.equal(active(store.get()).events.length, 20);
});
