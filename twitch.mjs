export class Twitch {
  constructor({ clientId, onChat, onStatus, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
    Object.assign(this, { clientId, onChat, onStatus, fetchImpl, WebSocketImpl });
    this.status = { connected: false, message: 'Local studio', login: null, canReply: false };
    this.generation = 0;
    this.seen = new Set();
    this.timers = new Set();
  }
  setStatus(message, connected = false) {
    this.status = {
      connected,
      message,
      login: this.user?.login || null,
      canReply: Boolean(this.user?.scopes.includes('user:write:chat')),
    };
    this.onStatus(this.status);
  }
  async api(path, options = {}) {
    const response = await this.fetchImpl(`https://api.twitch.tv/helix/${path}`, {
      ...options,
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Client-Id': this.clientId,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok)
      throw new Error(
        `Twitch API returned ${response.status}. Reconnect if authorization expired.`,
      );
    return response.status === 204 ? null : response.json();
  }
  async validate(token) {
    if (!this.clientId)
      throw new Error('Set TWITCH_CLIENT_ID in .env and restart While You Were AFK.');
    if (typeof token !== 'string' || !token.length || token.length > 2048)
      throw new Error('Invalid Twitch token.');
    const response = await this.fetchImpl('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('Invalid or expired Twitch token.');
    const user = await response.json();
    if (user.client_id !== this.clientId || !user.scopes?.includes('user:read:chat'))
      throw new Error('Wrong Twitch app or missing chat permission.');
    if (typeof user.user_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(user.user_id))
      throw new Error('Invalid Twitch identity.');
    return user;
  }
  async authorize(token, { start = true } = {}) {
    const run = this.generation;
    const user = await this.validate(token);
    if (run !== this.generation) throw new Error('Connection request was superseded.');
    this.disconnect();
    this.user = user;
    this.token = token;
    this.seen.clear();
    this.setStatus(`Connecting to ${user.login}…`);
    if (start) this.connect();
    this.scheduleValidation(this.generation);
    return user;
  }
  scheduleValidation(run) {
    this.later(
      async () => {
        if (run !== this.generation || !this.token) return;
        try {
          await this.validate(this.token);
          if (run === this.generation) this.scheduleValidation(run);
        } catch {
          if (run !== this.generation) return;
          this.disconnect();
          this.setStatus('Twitch authorization expired. Connect again.');
        }
      },
      60 * 60 * 1000,
    );
  }
  disconnect() {
    this.generation++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.socket?.close();
    this.socket = null;
    this.token = null;
    this.user = null;
    this.setStatus('Local studio');
  }
  later(callback, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }
  connect(url = 'wss://eventsub.wss.twitch.tv/ws', transferring = false, run = this.generation) {
    if (run !== this.generation || !this.token) return;
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'wss:' || !endpoint.hostname.endsWith('.twitch.tv'))
      throw new Error('Invalid Twitch reconnect address.');
    const previous = this.socket,
      ws = new this.WebSocketImpl(url);
    this.socket = ws;
    let watchdog;
    const heartbeat = (seconds = 30) => {
      clearTimeout(watchdog);
      this.timers.delete(watchdog);
      watchdog = this.later(() => ws.close(), (seconds + 5) * 1000);
    };
    ws.onmessage = async ({ data }) => {
      if (run !== this.generation || this.socket !== ws) return;
      try {
        const { metadata, payload } = JSON.parse(data);
        heartbeat(payload.session?.keepalive_timeout_seconds || 30);
        if (metadata.message_type === 'session_welcome') {
          if (transferring) previous?.close();
          else
            await this.api('eventsub/subscriptions', {
              method: 'POST',
              body: JSON.stringify({
                type: 'channel.chat.message',
                version: '1',
                condition: { broadcaster_user_id: this.user.user_id, user_id: this.user.user_id },
                transport: { method: 'websocket', session_id: payload.session.id },
              }),
            });
          if (run === this.generation && this.socket === ws)
            this.setStatus(`Connected to ${this.user.login}`, true);
        } else if (metadata.message_type === 'session_reconnect') {
          this.connect(payload.session.reconnect_url, true, run);
        } else if (metadata.message_type === 'revocation') {
          this.disconnect();
          this.setStatus('Twitch permission revoked. Connect again.');
        } else if (
          metadata.message_type === 'notification' &&
          metadata.subscription_type === 'channel.chat.message'
        ) {
          const event = payload.event;
          // Ignore messages originating in another channel's shared chat.
          if (
            event.broadcaster_user_id !== this.user.user_id ||
            (event.source_broadcaster_user_id &&
              event.source_broadcaster_user_id !== this.user.user_id)
          )
            return;
          if (this.seen.has(event.message_id)) return;
          this.seen.add(event.message_id);
          if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
          Promise.resolve(this.onChat(event)).catch((error) =>
            this.onStatus({ ...this.status, notice: error.message }),
          );
        }
      } catch (error) {
        if (run !== this.generation) return;
        this.setStatus(error.message);
        ws.close();
      }
    };
    ws.onclose = () => {
      clearTimeout(watchdog);
      this.timers.delete(watchdog);
      if (run !== this.generation || this.socket !== ws || !this.token) return;
      this.setStatus('Connection lost. Reconnecting…');
      this.later(() => this.connect(undefined, false, run), 5000);
    };
    ws.onerror = () => {
      if (run === this.generation && this.socket === ws) this.setStatus('Twitch connection error.');
    };
    heartbeat();
  }
  async reply(message) {
    if (!this.status.connected || !this.status.canReply)
      throw new Error('Reconnect with chat reply permission.');
    const result = await this.api('chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        broadcaster_id: this.user.user_id,
        sender_id: this.user.user_id,
        message: message.slice(0, 490),
      }),
    });
    if (!result.data?.[0]?.is_sent)
      throw new Error(result.data?.[0]?.drop_reason?.message || 'Twitch did not send the reply.');
  }
}
