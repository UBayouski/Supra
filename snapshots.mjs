import { text, types } from './model.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid saved stream data.');
  return value;
};
const id = (value) => {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new Error('Invalid saved moment or stream ID.');
  return value;
};
const integer = (value) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid saved timestamp or count.');
  return value;
};
const timestamp = (value) => {
  if (integer(value) > 8640000000000000) throw new Error('Invalid saved timestamp.');
  return value;
};
const optionalText = (value) => (value == null ? null : text(value, 200));
function unique(items) {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error('Duplicate saved IDs.');
  return items;
}

// Browser backups are untrusted input. Rebuild only supported fields and bind every
// stream to the identity established by Twitch, never an ID supplied by the client.
export function restoreSnapshot(input, channelId) {
  object(input);
  if (input.version !== 1 || input.channelId !== channelId)
    throw new Error('This backup belongs to a different Twitch channel.');
  const state = object(input.state);
  if (
    state.version !== 1 ||
    !Array.isArray(state.sessions) ||
    !state.sessions.length ||
    state.sessions.length > 100
  ) {
    throw new Error('Invalid saved stream archive.');
  }
  const sessions = unique(
    state.sessions.map((raw) => {
      const session = object(raw);
      if (session.demo || session.channel !== channelId)
        throw new Error("Only this channel's real streams can be restored.");
      if (
        !Array.isArray(session.events) ||
        session.events.length > 1000 ||
        !Array.isArray(session.nominations) ||
        session.nominations.length > 5000
      )
        throw new Error('Saved stream exceeds its limits.');
      const events = unique(
        session.events.map((raw) => {
          const item = object(raw);
          if (!types.includes(item.type)) throw new Error('Invalid saved moment type.');
          return {
            id: id(item.id),
            type: item.type,
            text: text(item.text),
            author: text(item.author, 50),
            source: item.source === 'twitch' ? 'twitch' : 'local',
            at: timestamp(item.at),
            offset: integer(item.offset),
            messageId: optionalText(item.messageId),
            nominationId: item.nominationId == null ? null : id(item.nominationId),
          };
        }),
      );
      const nominations = unique(
        session.nominations.map((raw) => {
          const item = object(raw);
          if (!['pending', 'approved', 'rejected'].includes(item.status))
            throw new Error('Invalid saved nomination status.');
          return {
            id: id(item.id),
            text: text(item.text),
            author: text(item.author, 50),
            authorId: text(item.authorId, 200),
            source: item.source === 'twitch' ? 'twitch' : 'local',
            messageId: optionalText(item.messageId),
            at: timestamp(item.at),
            status: item.status,
            ...(item.reviewedAt === undefined ? {} : { reviewedAt: timestamp(item.reviewedAt) }),
          };
        }),
      );
      const pending = nominations.filter((item) => item.status === 'pending');
      if (pending.length > 100) throw new Error('Saved moderation queue exceeds its limit.');
      const counts = new Map();
      for (const item of pending) {
        const count = (counts.get(item.authorId) || 0) + 1;
        counts.set(item.authorId, count);
        if (count > 3) throw new Error('Saved viewer nominations exceed their limit.');
      }
      return {
        id: id(session.id),
        title: text(session.title, 100),
        channel: channelId,
        startedAt: timestamp(session.startedAt),
        catchupRequests: integer(session.catchupRequests ?? 0),
        events,
        nominations,
      };
    }),
  );
  if (!sessions.some((session) => session.id === state.activeId))
    throw new Error('Saved active stream is missing.');
  return { version: 1, activeId: state.activeId, sessions };
}
