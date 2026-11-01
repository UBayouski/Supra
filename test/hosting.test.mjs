import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp as createServerApp } from '../server.mjs';
import { active, addEvent, newSession, initialState } from '../model.mjs';
const createApp = (options) => createServerApp({ publicUrl: '', host: '127.0.0.1', ...options });

function twitchFixture() {
  const sockets = [];
  class Socket {
    constructor() {
      sockets.push(this);
    }
    close() {
      this.onclose?.();
    }
    async emit(type, payload) {
      await this.onmessage({
        data: JSON.stringify({
          metadata: { message_type: type, subscription_type: 'channel.chat.message' },
          payload,
        }),
      });
    }
  }
  return {
    sockets,
    WebSocketImpl: Socket,
    async fetchImpl(url, options) {
      const token = options.headers.Authorization?.split(' ')[1];
      return {
        ok: token !== 'invalid',
        status: token === 'invalid' ? 401 : 200,
        json: async () =>
          url.includes('/validate')
            ? {
                client_id: 'test-app',
                user_id: token,
                login: `streamer-${token}`,
                scopes: ['user:read:chat', 'user:write:chat'],
              }
            : { data: [{ is_sent: true }] },
      };
    },
  };
}
async function client(origin, cookie = '', { autoRestore = true, storage = new Map() } = {}) {
  async function request(path, data) {
    const response = await fetch(origin + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.headers.has('set-cookie'))
      cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json();
    if (response.ok && value.authenticated && value.needsRestore && autoRestore) {
      return request('/api/restore', { snapshot: storage.get(value.channelId) || null });
    }
    if (response.ok && value.backup && !value.needsRestore)
      storage.set(value.channelId, value.backup);
    return { status: response.status, value, headers: response.headers };
  }
  return {
    request,
    storage,
    get cookie() {
      return cookie;
    },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'supra-hosting-'));
  const twitch = twitchFixture();
  const app = await createApp({ port: 0, directory, clientId: 'test-app', ...twitch });
  const origin = await app.listen();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, directory, origin, twitch };
}

test('browsers and verified channels isolate state, edits, exports, and overlay access', async (t) => {
  const { origin, twitch, directory } = await fixture(t);
  const a = await client(origin),
    b = await client(origin),
    guest = await client(origin);
  let response = await a.request('/api/state');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  await a.request('/api/action', { action: 'add', type: 'goal', text: 'Private guest goal' });
  assert.equal((await b.request('/api/state')).value.recap.goal, null);
  assert.equal((await a.request('/api/connect', { token: 'invalid' })).status, 400);
  assert.equal((await a.request('/api/state')).value.authenticated, false);
  await a.request('/api/connect', { token: '101' });
  await b.request('/api/connect', { token: '202' });
  await a.request('/api/action', { action: 'add', type: 'goal', text: 'Channel A goal' });
  const stateA = (await a.request('/api/state')).value;
  assert.equal(stateA.session.events.length, 1, 'guest data was not copied');
  assert.equal(stateA.session.channel, '101');
  await a.request('/api/action', { action: 'nominate', text: 'Pending secret', author: 'Viewer' });
  const stateB = (await b.request('/api/state')).value;
  assert.equal(stateB.recap.goal, null);
  assert.equal(
    (await b.request('/api/action', { action: 'remove', id: stateA.recap.goal.id })).status,
    400,
  );
  assert.equal(
    (await b.request('/api/action', { action: 'switch', id: stateA.session.id })).status,
    400,
  );
  assert.equal((await guest.request('/api/state')).value.authenticated, false);
  assert.equal((await guest.request('/api/overlay')).value.recap.sources.length, 0);
  assert.ok(!JSON.stringify((await b.request('/api/export')).value).includes('Channel A goal'));
  const overlayKey = stateA.overlayPath.split('/').at(-1);
  assert.equal(
    (await guest.request(`/api/overlay/${overlayKey}`)).value.recap.sources[0].text,
    'Channel A goal',
  );
  const overlay = JSON.stringify((await guest.request(`/api/overlay/${overlayKey}`)).value);
  for (const secret of ['Pending secret', 'nominations', 'messageId', 'author', 'channelId'])
    assert.ok(!overlay.includes(secret));
  assert.equal((await guest.request(`/api/overlay/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await guest.request(`/overlay/${overlayKey}`, {})).status, 404);
  const exported = (await a.request('/api/export')).value;
  assert.equal(exported.overlayKey, undefined);
  await assert.rejects(readFile(join(directory, 'channels', '101', 'state.json')), {
    code: 'ENOENT',
  });
  assert.ok(!JSON.stringify(stateA.backup).includes('token'));
  assert.equal(stateA.backup.channelId, '101');
  assert.equal(twitch.sockets.length, 2);
});

test('live channel is shared while running; browser backup restores it and its OBS key after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'supra-restart-'));
  const twitch = twitchFixture();
  let app = await createApp({ port: 0, directory, clientId: 'test-app', ...twitch });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  let origin = await app.listen();
  const a = await client(origin),
    b = await client(origin);
  await a.request('/api/connect', { token: '101' });
  await a.request('/api/action', { action: 'add', type: 'rule', text: 'Persistent rule' });
  const state = (await a.request('/api/state')).value;
  await b.request('/api/connect', { token: '101' });
  assert.equal((await b.request('/api/state')).value.recap.rule.text, 'Persistent rule');
  await a.request('/api/disconnect', {});
  assert.equal((await a.request('/api/state')).value.recap.rule, null);
  assert.equal((await b.request('/api/state')).value.authenticated, true);
  assert.equal((await b.request('/api/state')).value.status.login, 'streamer-101');
  const oldCookie = b.cookie;
  await app.close();
  app = await createApp({ port: 0, directory, clientId: 'test-app', ...twitch });
  origin = await app.listen();
  const restarted = await client(origin, oldCookie, { storage: b.storage });
  assert.equal((await restarted.request('/api/state')).value.authenticated, false);
  const key = state.overlayPath.split('/').at(-1);
  assert.equal((await restarted.request(`/api/overlay/${key}`)).status, 404);
  const waiting = await fetch(`${origin}${state.overlayPath}`);
  assert.equal(waiting.status, 200);
  await waiting.text();
  await restarted.request('/api/connect', { token: '101' });
  assert.equal(
    (await restarted.request(`/api/overlay/${key}`)).value.recap.sources[0].text,
    'Persistent rule',
  );
  const restored = (await restarted.request('/api/state')).value;
  assert.equal(restored.recap.rule.text, 'Persistent rule');
  assert.equal(restored.overlayPath, state.overlayPath);
  assert.equal(restored.replies, false);
});

test('legacy data migrates only for its verified channel and original file is untouched', async (t) => {
  const { directory, origin } = await fixture(t);
  const legacy = initialState();
  {
    const state = legacy;
    active(state).channel = '101';
    addEvent(active(state), { type: 'goal', text: 'Legacy real stream' });
    const other = newSession('Other channel', Date.now(), '202');
    addEvent(other, { type: 'rule', text: 'Other private rule' });
    state.sessions.push(other);
    const unbound = newSession('Unbound stream');
    addEvent(unbound, { type: 'rule', text: 'Unbound secret' });
    state.sessions.push(unbound);
  }
  await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
  const before = await readFile(join(directory, 'state.json'), 'utf8');
  const a = await client(origin);
  await a.request('/api/connect', { token: '101' });
  const saved = (await a.request('/api/export')).value;
  assert.equal(saved.sessions.length, 1);
  assert.equal(saved.sessions[0].events[0].text, 'Legacy real stream');
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
});

test('hosted origin, secure cookies, health probe, and cross-origin requests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'supra-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createApp({ directory, publicUrl: 'http://public.example' }), /HTTPS/);
  await assert.rejects(createApp({ directory, publicUrl: 'https://public.example/path' }), /plain/);
  const app = await createApp({
    port: 0,
    directory,
    publicUrl: 'https://studio.example',
    host: '127.0.0.1',
  });
  await app.listen();
  t.after(() => app.close());
  const local = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(local + '/health')).status, 200);
  assert.equal((await fetch(local + '/api/state')).status, 421);
  const request = (path, method = 'GET', origin) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        local + path,
        {
          method,
          headers: {
            Host: 'studio.example',
            ...(origin ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response));
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  const good = await request('/api/state');
  assert.equal(good.statusCode, 200);
  assert.match(good.headers['set-cookie'][0], /; Secure/);
  const blocked = await request('/api/action', 'POST', 'https://other.example');
  assert.equal(blocked.statusCode, 403);
});

test('studio and overlay event streams update only the intended channel', async (t) => {
  const { origin } = await fixture(t);
  const a = await client(origin),
    b = await client(origin);
  await a.request('/api/connect', { token: '101' });
  await b.request('/api/connect', { token: '202' });
  const key = (await a.request('/api/state')).value.overlayPath.split('/').at(-1);
  const controllers = [],
    readers = [];
  async function stream(path, cookie) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(origin + path, {
      headers: { Cookie: cookie || '' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    readers.push(reader);
    return reader;
  }
  t.after(() => {
    for (const controller of controllers) controller.abort();
  });
  const studioA = await stream('/api/events', a.cookie),
    studioB = await stream('/api/events', b.cookie);
  const obs = await stream(`/api/overlay-events/${key}`);
  const read = async (reader) => new TextDecoder().decode((await reader.read()).value);
  await read(studioA);
  await read(studioB);
  await read(obs);
  await a.request('/api/action', { action: 'add', type: 'goal', text: 'Only A sees this' });
  assert.match(await read(studioA), /Only A sees this/);
  assert.match(await read(obs), /Only A sees this/);
  await b.request('/api/action', { action: 'add', type: 'goal', text: 'Only B sees this' });
  const bUpdate = await read(studioB);
  assert.match(bUpdate, /Only B sees this/);
  assert.ok(!bUpdate.includes('Only A sees this'));
  await a.request('/api/disconnect', {});
  assert.match(await read(studioA), /"authenticated":false/);
  for (const controller of controllers) controller.abort();
});

test('restoring requires verified identity and completes before live chat starts or edits are allowed', async (t) => {
  const { origin, twitch } = await fixture(t);
  const a = await client(origin, '', { autoRestore: false });
  assert.equal((await a.request('/api/restore', { snapshot: null })).status, 400);
  const connected = (await a.request('/api/connect', { token: '101' })).value;
  assert.equal(connected.needsRestore, true);
  assert.equal(connected.backup, null);
  assert.equal(twitch.sockets.length, 0);
  assert.equal(
    (await a.request('/api/action', { action: 'add', type: 'goal', text: 'Too early' })).status,
    400,
  );
  const state = initialState();
  active(state).channel = '202';
  const other = { version: 1, channelId: '202', state };
  assert.equal((await a.request('/api/restore', { snapshot: other })).status, 400);
  assert.equal((await a.request('/api/state')).value.needsRestore, true);
  active(state).channel = '101';
  // A normal archive readily exceeds the ordinary 16 KB action request limit.
  for (let i = 0; i < 100; i++)
    addEvent(active(state), { type: 'milestone', text: `Moment ${i} ${'x'.repeat(180)}` });
  const backup = { version: 1, channelId: '101', overlayKey: 'b'.repeat(64), state };
  const restored = await a.request('/api/restore', { snapshot: backup });
  assert.equal(restored.status, 200);
  assert.equal(restored.value.needsRestore, false);
  assert.equal(restored.value.session.events.length, 100);
  assert.equal(twitch.sockets.length, 1);
  assert.equal(restored.value.replies, false);
  assert.equal(restored.value.overlayPath, `/overlay/${backup.overlayKey}`);
});

test('a stale browser backup cannot overwrite a channel already restored by another browser', async (t) => {
  const { origin } = await fixture(t);
  const a = await client(origin),
    b = await client(origin, '', { autoRestore: false });
  await a.request('/api/connect', { token: '101' });
  await a.request('/api/action', { action: 'add', type: 'goal', text: 'Live authoritative goal' });
  const state = initialState();
  active(state).channel = '101';
  addEvent(active(state), { type: 'goal', text: 'Old stale goal' });
  await b.request('/api/connect', { token: '101' });
  const response = await b.request('/api/restore', {
    snapshot: { version: 1, channelId: '101', state },
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.recap.goal.text, 'Live authoritative goal');
});

test('restoring another channel cannot claim an existing channel overlay key', async (t) => {
  const { origin } = await fixture(t);
  const a = await client(origin),
    b = await client(origin, '', { autoRestore: false });
  const first = (await a.request('/api/connect', { token: '101' })).value;
  await b.request('/api/connect', { token: '202' });
  const state = initialState();
  active(state).channel = '202';
  const response = await b.request('/api/restore', {
    snapshot: {
      version: 1,
      channelId: '202',
      state,
      overlayKey: first.overlayPath.split('/').at(-1),
    },
  });
  assert.equal(response.status, 400);
  assert.match(response.value.error, /OBS key/);
  assert.equal((await b.request('/api/state')).value.needsRestore, true);
});
