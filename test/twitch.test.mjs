import test from 'node:test';
import assert from 'node:assert/strict';
import { Twitch } from '../twitch.mjs';

function fixture(scopes = ['user:read:chat', 'user:write:chat']) {
  const sockets = [], calls = [], messages = [], statuses = [];
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.onclose?.(); }
    emit(type, payload, subscription) {
      return this.onmessage({ data: JSON.stringify({ metadata: { message_type: type, subscription_type: subscription }, payload }) });
    }
  }
  const twitch = new Twitch({ clientId: 'app-id', WebSocketImpl: Socket,
    onChat: message => messages.push(message), onStatus: status => statuses.push(status),
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return { ok: true, status: url.includes('subscriptions') ? 202 : 200,
        json: async () => url.includes('/validate') ? { client_id: 'app-id', user_id: 'broadcaster', login: 'streamer', scopes }
          : url.includes('/chat/messages') ? { data: [{ is_sent: true }] } : { data: [] } };
    },
  });
  return { twitch, sockets, calls, messages, statuses };
}
test('Twitch validates the token, creates an own-channel subscription, and replies only with write permission', async t => {
  const { twitch, sockets, calls } = fixture();
  t.after(() => twitch.disconnect());
  await twitch.authorize('token-held-in-memory');
  assert.equal(twitch.status.connected, false);
  await sockets[0].emit('session_welcome', { session: { id: 'socket-session', keepalive_timeout_seconds: 30 } });
  assert.equal(twitch.status.connected, true);
  const subscription = calls.find(call => call.url.includes('subscriptions'));
  assert.deepEqual(JSON.parse(subscription.options.body).condition, { broadcaster_user_id: 'broadcaster', user_id: 'broadcaster' });
  await twitch.reply('While you were AFK: the approved story');
  assert.equal(JSON.parse(calls.at(-1).options.body).sender_id, 'broadcaster');
  twitch.disconnect();
  assert.equal(twitch.token, null);
  assert.equal(twitch.user, null);
  await assert.rejects(twitch.reply('No session'), /Reconnect/);
});
test('Twitch notifications are deduplicated and shared-channel messages are excluded', async t => {
  const { twitch, sockets, messages } = fixture();
  t.after(() => twitch.disconnect());
  await twitch.authorize('token');
  const event = { broadcaster_user_id: 'broadcaster', message_id: 'one', message: { text: '!catchup' } };
  await sockets[0].emit('notification', { event }, 'channel.chat.message');
  await sockets[0].emit('notification', { event }, 'channel.chat.message');
  await sockets[0].emit('notification', { event: { ...event, message_id: 'two', source_broadcaster_user_id: 'other-channel' } }, 'channel.chat.message');
  assert.equal(messages.length, 1);
  await sockets[0].emit('revocation', {});
  assert.equal(twitch.status.connected, false);
  assert.equal(twitch.token, null);
});
test('read-only authorization cannot send replies and missing read permission is rejected', async t => {
  const { twitch, sockets } = fixture(['user:read:chat']);
  t.after(() => twitch.disconnect());
  await twitch.authorize('token');
  await sockets[0].emit('session_welcome', { session: { id: 'session' } });
  await assert.rejects(twitch.reply('Must not send'), /permission/);
  const invalid = fixture(['user:write:chat']);
  t.after(() => invalid.twitch.disconnect());
  await assert.rejects(invalid.twitch.authorize('token'), /missing chat permission/);
  assert.equal(invalid.sockets.length, 0);
});

test('disconnect supersedes in-flight authorization without resurrecting credentials', async () => {
  const { twitch, sockets } = fixture();
  const originalFetch = twitch.fetchImpl;
  let resume;
  twitch.fetchImpl = async (...args) => {
    await new Promise(resolve => { resume = resolve; });
    return originalFetch(...args);
  };
  const pending = twitch.authorize('token');
  twitch.disconnect(); resume();
  await assert.rejects(pending, /superseded/);
  assert.equal(twitch.token, null); assert.equal(sockets.length, 0);
});

test('periodic validation disconnects revoked Twitch credentials', async t => {
  const { twitch } = fixture();
  t.after(() => twitch.disconnect());
  let revalidate;
  const later = twitch.later.bind(twitch);
  twitch.later = (callback, delay) => {
    if (delay === 60 * 60 * 1000) { revalidate = callback; return; }
    return later(callback, delay);
  };
  await twitch.authorize('token');
  twitch.fetchImpl = async () => ({ ok: false });
  await revalidate();
  assert.equal(twitch.token, null);
  assert.match(twitch.status.message, /expired/);
});
