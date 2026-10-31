import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { active, initialState } from './model.mjs';
import { memoryStore } from './store.mjs';
import { restoreSnapshot } from './snapshots.mjs';
import { createWorkspace } from './workspace.mjs';

const cookieName = 'supra_session', sessionLifetime = 6 * 60 * 60 * 1000;
const keyPattern = /^[a-f0-9]{64}$/, channelPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const randomKey = () => randomBytes(32).toString('hex');

export async function createApp({ port = Number(process.env.PORT || 3001),
  directory = process.env.SUPRA_DATA_DIR || fileURLToPath(new URL('./.data', import.meta.url)),
  publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
  host = process.env.HOST || (publicUrl ? '0.0.0.0' : '127.0.0.1'),
  clientId = process.env.TWITCH_CLIENT_ID || '', fetchImpl = fetch, WebSocketImpl = WebSocket,
  maxSessions = 500, maxChannels = 500 } = {}) {
  let origin = publicUrl ? new URL(publicUrl).origin : `http://localhost:${port}`;
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
      throw new Error('PUBLIC_URL must be a plain HTTPS origin. HTTP localhost is allowed for development.');
    }
  }
  const browsers = new Map(), channels = new Map(), overlayOwners = new Map();
  const serverId = randomKey();
  const browserState = browser => ({ ...browser.workspace.state(), serverId, browserGeneration: browser.generation });
  const send = (response, type, data) => {
    if (!response.destroyed && !response.writableEnded) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  function publish(workspace, notice) {
    for (const browser of browsers.values()) if (browser.workspace === workspace) {
      for (const response of browser.clients) send(response, notice ? 'notice' : 'state', notice ? { message: notice } : browserState(browser));
    }
    if (!notice) for (const response of workspace.overlayClients) send(response, 'state', workspace.overlayState());
  }
  function workspace(options) {
    let result;
    result = createWorkspace({ ...options, clientId, fetchImpl, WebSocketImpl,
      onPublish: () => publish(result), onNotice: notice => publish(result, notice) });
    return result;
  }
  const guestWorkspace = () => workspace({ store: memoryStore() });
  function release(workspace) {
    if (![...browsers.values()].some(browser => browser.workspace === workspace)) {
      workspace.resetReplies(); workspace.twitch.disconnect();
    }
  }
  function prune() {
    for (const [id, browser] of browsers) if (!browser.busy && Date.now() - browser.lastSeen > sessionLifetime) {
      browsers.delete(id);
      for (const response of browser.clients) response.end();
      if (!browser.workspace.channelId) for (const response of browser.workspace.overlayClients) response.end();
      release(browser.workspace);
    }
  }
  function getBrowser(request, response) {
    const supplied = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let browser = browsers.get(supplied);
    if (!browser) {
      prune();
      if (browsers.size >= maxSessions) throw new Error('The server is busy. Please try again later.');
      const id = randomKey();
      browser = { workspace: guestWorkspace(), clients: new Set(), overlayClients: new Set(), generation: 0, lastSeen: Date.now(), queue: Promise.resolve(), busy: 0 };
      browsers.set(id, browser);
      response.setHeader('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`);
    }
    browser.lastSeen = Date.now(); return browser;
  }
  async function legacySnapshot(channelId) {
    // Read-only migration for local users. Hosted deployments never read legacy files.
    if (publicUrl) return null;
    try {
      const saved = JSON.parse(await readFile(join(directory, 'channels', channelId, 'state.json'), 'utf8'));
      if (saved.channelId === channelId) return { version: 1, channelId, overlayKey: saved.overlayKey, state: saved };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let legacy;
    try { legacy = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const sessions = legacy.sessions?.filter(session => !session.demo && session.channel === channelId);
    if (!sessions?.length) return null;
    return { version: 1, channelId, state: { version: 1, sessions,
      activeId: sessions.some(session => session.id === legacy.activeId) ? legacy.activeId : sessions.at(-1).id } };
  }
  function channel(channelId) {
    if (!channelPattern.test(channelId)) throw new Error('Invalid Twitch identity.');
    if (!channels.has(channelId)) {
      if (channels.size >= maxChannels) throw new Error('Channel capacity reached.');
      const initial = initialState(); active(initial).channel = channelId;
      const store = memoryStore(initial);
      const result = workspace({ store, channelId, overlayKey: randomKey() });
      channels.set(channelId, result); overlayOwners.set(result.overlayKey, channelId);
    }
    return channels.get(channelId);
  }
  function channelOperation(target, operation) {
    const pending = (target.queue || Promise.resolve()).then(operation);
    target.queue = pending.catch(() => {});
    return pending;
  }
  const cleanup = setInterval(prune, 60000); cleanup.unref();
  const json = (response, code, data) => {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  async function body(request, limit = 16000) {
    let content = '';
    for await (const chunk of request) {
      content += chunk;
      if (Buffer.byteLength(content) > limit) throw new Error('Request too large.');
    }
    const value = JSON.parse(content || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value;
  }
  function subscribe(request, response, collection, data, browser) {
    if (collection.size >= 8) { json(response, 429, { error: 'Too many open tabs. Close another tab and retry.' }); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    collection.add(response); send(response, 'state', data);
    if (browser && collection !== browser.clients) browser.overlayClients.add(response);
    const timer = setInterval(() => {
      if (browser) browser.lastSeen = Date.now();
      if (!response.destroyed) response.write(': keepalive\n\n');
    }, 20000); timer.unref();
    response.on('close', () => { collection.delete(response); browser?.overlayClients.delete(response); clearInterval(timer); });
  }
  const files = { '/': 'index.html', '/overlay': 'overlay.html', '/app.js': 'app.js',
    '/overlay.js': 'overlay.js', '/channel-storage.js': 'channel-storage.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
  const posts = ['/api/connect', '/api/restore', '/api/disconnect', '/api/replies', '/api/action', '/api/simulate'];
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const path = new URL(request.url, origin).pathname;
      if (path === '/health' && ['GET', 'HEAD'].includes(request.method)) { json(response, 200, { ok: true }); return; }
      if (request.headers.host !== new URL(origin).host) { json(response, 421, { error: `Open ${origin} instead.` }); return; }
      if (request.method === 'POST') {
        if (request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json')) {
          json(response, 403, { error: 'Origin or content type not allowed.' }); return;
        }
        if (!posts.includes(path)) { json(response, 404, { error: 'Not found.' }); return; }
        const data = await body(request, path === '/api/restore' ? 4 * 1024 * 1024 : 16000), browser = getBrowser(request, response);
        browser.busy++;
        const operation = browser.queue.then(async () => {
          if (path === '/api/connect') {
            const verifier = guestWorkspace();
            const user = await verifier.twitch.validate(data.token);
            const target = await channel(user.user_id);
            await channelOperation(target, async () => {
              await target.twitch.authorize(data.token, { start: target.ready });
              target.resetReplies();
            });
            const previous = browser.workspace;
            for (const client of browser.overlayClients) client.end();
            browser.workspace = target; browser.generation++; release(previous); publish(target);
          } else if (path === '/api/restore') {
            const target = browser.workspace;
            if (!target.channelId) throw new Error('Connect Twitch before restoring saved streams.');
            await channelOperation(target, async () => {
              // Another signed-in tab may already have restored/edited this channel.
              if (target.ready) return;
              const snapshot = data.snapshot ?? await legacySnapshot(target.channelId);
              const restored = snapshot ? restoreSnapshot(snapshot, target.channelId) : null;
              const key = snapshot?.overlayKey ?? target.overlayKey;
              if (!keyPattern.test(key) || (overlayOwners.has(key) && overlayOwners.get(key) !== target.channelId)) {
                throw new Error('Invalid saved OBS key.');
              }
              const previousKey = target.overlayKey;
              await target.restore(restored, key);
              overlayOwners.delete(previousKey); overlayOwners.set(key, target.channelId);
            });
          } else if (path === '/api/disconnect') {
            const previous = browser.workspace;
            for (const client of browser.overlayClients) client.end();
            browser.workspace = guestWorkspace(); browser.generation++; release(previous);
            for (const client of browser.clients) send(client, 'state', browserState(browser));
          } else {
            if (!browser.workspace.ready) throw new Error('Restore your browser backup before editing this channel.');
            if (path === '/api/replies') browser.workspace.setReplies(data.enabled);
            else if (path === '/api/action') await browser.workspace.action(data);
            else await browser.workspace.simulate(data);
          }
          return browserState(browser);
        });
        browser.queue = operation.catch(() => {});
        try { json(response, 200, await operation); } finally { browser.busy--; }
        return;
      }
      if (request.method !== 'GET') { json(response, 405, { error: 'Method not allowed.' }); return; }
      if (path === '/api/config') { json(response, 200, { clientId, redirectUri: origin }); return; }
      const overlayMatch = /^\/(overlay|api\/overlay|api\/overlay-events)\/([a-f0-9]{64})$/.exec(path);
      let overlayWorkspace;
      if (overlayMatch) {
        const owner = overlayOwners.get(overlayMatch[2]);
        if (!owner && overlayMatch[1] !== 'overlay') { json(response, 404, { error: 'Overlay not found.' }); return; }
        if (owner) overlayWorkspace = channel(owner);
        if (overlayMatch[1] === 'api/overlay') { json(response, 200, overlayWorkspace.overlayState()); return; }
        if (overlayMatch[1] === 'api/overlay-events') {
          subscribe(request, response, overlayWorkspace.overlayClients, overlayWorkspace.overlayState()); return;
        }
      }
      if (['/api/state', '/api/events', '/api/export', '/api/overlay', '/api/overlay-events'].includes(path)) {
        const browser = getBrowser(request, response); await browser.queue;
        const workspace = browser.workspace;
        if (path === '/api/state') json(response, 200, browserState(browser));
        else if (path === '/api/export') {
          response.setHeader('Content-Disposition', 'attachment; filename="while-you-were-afk.json"');
          const exported = workspace.store.get(); delete exported.overlayKey; json(response, 200, exported);
        } else if (path === '/api/overlay') json(response, 200, workspace.overlayState());
        else if (path === '/api/events') subscribe(request, response, browser.clients, browserState(browser), browser);
        else subscribe(request, response, workspace.overlayClients, workspace.overlayState(), browser);
        return;
      }
      const file = overlayMatch?.[1] === 'overlay' ? 'overlay.html' : files[path];
      if (!file) { json(response, 404, { error: 'Not found.' }); return; }
      const content = await readFile(new URL(`./public/${file}`, import.meta.url));
      const extension = file.split('.').pop();
      response.writeHead(200, { 'Content-Type': { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' }[extension], 'Cache-Control': 'no-store' });
      response.end(content);
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: error.message }); else response.end();
    }
  });
  return { server, get origin() { return origin; }, async listen() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    if (!publicUrl) origin = `http://localhost:${server.address().port}`; return origin;
  }, async close() {
    clearInterval(cleanup);
    for (const browser of browsers.values()) {
      await browser.queue;
      for (const response of browser.clients) response.end();
      if (!browser.workspace.channelId) for (const response of browser.workspace.overlayClients) response.end();
      browser.workspace.twitch.disconnect();
    }
    for (const workspace of channels.values()) {
      workspace.twitch.disconnect();
      for (const response of workspace.overlayClients) response.end();
    }
    await new Promise(resolve => server.close(resolve));
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp(); console.log(`While You Were AFK → ${await app.listen()}`);
  const shutdown = () => app.close().then(() => process.exit(0));
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
