import {
  active,
  addEvent,
  applyChat,
  loadDemo,
  moderate,
  newSession,
  nominate,
  recap,
  text,
} from './model.mjs';
import { Twitch } from './twitch.mjs';

export function createWorkspace({
  store,
  clientId,
  fetchImpl,
  WebSocketImpl,
  channelId = null,
  overlayKey = null,
  onPublish = () => {},
  onNotice = () => {},
}) {
  let replies = false,
    lastReply = -Infinity;
  let lastCatchup = null;
  let ready = !channelId;
  let revision = 0;
  const publicState = () => {
    const data = store.get(),
      session = active(data);
    return {
      session,
      sessions: data.sessions.map(({ id, title, startedAt, demo, channel }) => ({
        id,
        title,
        startedAt,
        demo,
        channel,
      })),
      recap: recap(session),
      status: twitch.status,
      replies,
      lastCatchup,
    };
  };
  function publish() {
    revision++;
    onPublish();
  }
  const twitch = new Twitch({
    clientId,
    fetchImpl,
    WebSocketImpl,
    onStatus(status) {
      if (status.notice) onNotice(status.notice);
      else publish();
    },
    async onChat(event) {
      if (!ready) return;
      const run = twitch.generation;
      let result;
      await store.change((state) => {
        const session = active(state);
        if (run !== twitch.generation) return;
        if (session.demo || session.channel !== event.broadcaster_user_id) return;
        result = applyChat(session, event);
      });
      if (!result || run !== twitch.generation) return;
      const request =
        result.kind === 'catchup'
          ? { author: event.chatter_user_name, at: Date.now(), sent: false }
          : null;
      if (request) lastCatchup = request;
      publish();
      if (result.kind === 'catchup' && replies && Date.now() - lastReply >= 15000) {
        lastReply = Date.now();
        // Keep responses short, and include only approved moments.
        const message = `While you were AFK: ${result.recap.sources.map((item) => `${item.type}: ${item.text.slice(0, 95)}`).join(' | ') || 'The story is just starting.'}`;
        await twitch.reply(message);
        request.sent = true;
        publish();
      }
    },
  });

  return {
    store,
    twitch,
    channelId,
    overlayKey,
    overlayClients: new Set(),
    state: () => ({
      ...publicState(),
      authenticated: Boolean(channelId),
      channelId,
      needsRestore: !ready,
      revision,
      backup: channelId && ready ? { version: 1, channelId, overlayKey, state: store.get() } : null,
      overlayPath: overlayKey ? `/overlay/${overlayKey}` : '/overlay',
    }),
    get ready() {
      return ready;
    },
    async restore(saved, key) {
      if (ready) return;
      if (saved)
        await store.change((state) => {
          for (const property of Object.keys(state)) delete state[property];
          Object.assign(state, saved);
        });
      overlayKey = key;
      this.overlayKey = key;
      ready = true;
      if (twitch.token) twitch.connect();
      publish();
    },
    overlayState() {
      const data = publicState();
      // Source metadata, author identities, nominations, and archive IDs stay in the studio.
      return {
        session: { title: data.session.title, demo: data.session.demo },
        recap: {
          sources: data.recap.sources.map(({ type, text, offset }) => ({ type, text, offset })),
        },
      };
    },
    resetReplies() {
      replies = false;
      lastCatchup = null;
    },
    async action(data) {
      await store.change((state) => {
        const session = active(state);
        if (data.action === 'add')
          addEvent(session, { type: data.type, text: data.text, author: 'Streamer' });
        else if (data.action === 'nominate')
          nominate(session, { text: data.text, author: data.author || 'Demo viewer' });
        else if (data.action === 'moderate')
          moderate(session, text(data.id, 36), data.decision, data.type);
        else if (data.action === 'remove') {
          const index = session.events.findIndex((item) => item.id === data.id);
          if (index === -1) throw new Error('Moment not found.');
          session.events.splice(index, 1);
        } else if (data.action === 'rename') session.title = text(data.title, 100);
        else if (data.action === 'new') {
          if (state.sessions.length >= 100)
            throw new Error(
              'Stream archive is full. Export your data before managing the archive.',
            );
          const fresh = newSession(data.title || 'Untitled stream', Date.now(), channelId);
          state.sessions.push(fresh);
          state.activeId = fresh.id;
        } else if (data.action === 'switch') {
          if (!state.sessions.some((item) => item.id === data.id))
            throw new Error('Stream not found.');
          // Archived streams must not receive newly arriving Twitch messages.
          twitch.disconnect();
          state.activeId = data.id;
        } else if (data.action === 'demo') {
          if (channelId) throw new Error('Disconnect your channel before loading the demo.');
          if (state.sessions.length >= 100) throw new Error('Stream archive is full.');
          loadDemo(state);
        } else throw new Error('Unknown action.');
      });
      if (['new', 'switch', 'demo'].includes(data.action)) {
        lastCatchup = null;
        replies = false;
      }

      publish();
    },
    async simulate(data) {
      if (!active(store.get()).demo) throw new Error('Load the demo stream to simulate chat.');
      let result;
      await store.change((state) => {
        result = applyChat(active(state), {
          message: { text: text(data.message, 300) },
          chatter_user_name: 'demo_viewer',
          chatter_user_id: 'demo-viewer',
          broadcaster_user_id: 'demo-streamer',
          badges: data.moderator ? [{ set_id: 'moderator' }] : [],
        });
      });
      if (!result)
        throw new Error('No change. Check the command or enable the demo moderator role.');
      if (result.kind === 'catchup')
        lastCatchup = { author: 'demo_viewer', at: Date.now(), sent: false };

      publish();
    },
    setReplies(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Expected enabled: true or false.');
      if (
        enabled &&
        (!twitch.status.connected || !twitch.status.canReply || active(store.get()).demo)
      )
        throw new Error('Connect a real stream with chat reply permission first.');
      replies = enabled;
      publish();
    },
  };
}
