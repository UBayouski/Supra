import { randomUUID } from 'node:crypto';

export const types = ['goal', 'milestone', 'joke', 'rule'];
export function text(value, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`Enter between 1 and ${max} characters.`);
  }
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
}
export function newSession(title = 'Untitled stream', now = Date.now(), channel = null) {
  return { id: randomUUID(), title: text(title, 100), startedAt: now, channel,
    events: [], nominations: [], catchupRequests: 0 };
}
export function initialState() {
  const session = newSession();
  return { version: 1, activeId: session.id, sessions: [session] };
}
export function active(state) {
  const session = state.sessions.find(item => item.id === state.activeId);
  if (!session) throw new Error('Stream session not found.');
  return session;
}
export function addEvent(session, input, now = Date.now()) {
  if (!types.includes(input.type)) throw new Error('Choose a valid moment type.');
  if (session.events.length >= 1000) throw new Error('This stream has reached 1,000 moments. Start a new stream.');
  const event = { id: randomUUID(), type: input.type, text: text(input.text),
    author: text(input.author || 'Streamer', 50), source: input.source === 'twitch' ? 'twitch' : 'local',
    at: now, offset: Math.max(0, Math.floor((now - session.startedAt) / 1000)),
    messageId: input.messageId || null, nominationId: input.nominationId || null };
  session.events.push(event);
  return event;
}
export function nominate(session, input, now = Date.now()) {
  if (session.nominations.filter(item => item.status === 'pending').length >= 100) throw new Error('The moderation queue is full.');
  const content = text(input.text), authorId = String(input.authorId || input.author || 'demo');
  if (session.nominations.some(item => item.status === 'pending' && item.authorId === authorId && item.text.toLowerCase() === content.toLowerCase())) {
    throw new Error('This viewer already nominated that moment.');
  }
  if (session.nominations.filter(item => item.status === 'pending' && item.authorId === authorId).length >= 3) {
    throw new Error('A viewer can have up to three pending nominations.');
  }
  const item = { id: randomUUID(), text: content, author: text(input.author || 'Viewer', 50),
    authorId, source: input.source === 'twitch' ? 'twitch' : 'local', messageId: input.messageId || null,
    at: now, status: 'pending' };
  session.nominations.push(item);
  return item;
}
export function moderate(session, id, decision, type = 'milestone', now = Date.now()) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('Choose approve or reject.');
  const matches = session.nominations.filter(item => item.status === 'pending' && item.id.startsWith(id));
  if (id.length < 8 || matches.length !== 1) throw new Error('Pending nomination not found or ID is ambiguous.');
  const item = matches[0];
  if (decision === 'approve') {
    // Preserve the time of the nominated moment, not the time of approval.
    addEvent(session, { ...item, type, nominationId: item.id }, item.at);
  }
  item.status = decision === 'approve' ? 'approved' : 'rejected';
  item.reviewedAt = now;
  return item;
}
export function recap(session) {
  const events = [...session.events].sort((a, b) => a.at - b.at);
  const latest = type => events.findLast(event => event.type === type) || null;
  const sources = [latest('goal'), latest('milestone'), latest('rule'), latest('joke')].filter(Boolean);
  const labels = { goal: 'The goal', milestone: 'Last big moment', rule: 'The rule', joke: 'The inside joke' };
  return { title: session.title, goal: latest('goal'), milestone: latest('milestone'),
    rule: latest('rule'), joke: latest('joke'), sources,
    text: sources.length ? sources.map(item => `${labels[item.type]}: ${item.text}`).join(' · ')
      : 'The story is just starting. Approved moments will appear here.' };
}
export function parseCommand(message) {
  const match = /^!(goal|milestone|joke|rule|moment|approve|reject|catchup)(?:\s+([\s\S]+))?$/i.exec(message.trim());
  if (!match) return null;
  const command = match[1].toLowerCase(), argument = match[2]?.trim() || '';
  if (command === 'catchup') return argument ? null : { command, argument };
  return argument ? { command, argument } : null;
}
export function applyChat(session, event, now = Date.now()) {
  const parsed = parseCommand(event.message?.text || '');
  if (!parsed) return null;
  const { command, argument } = parsed;
  const moderator = event.chatter_user_id === event.broadcaster_user_id
    || event.badges?.some(badge => badge.set_id === 'moderator' || badge.set_id === 'broadcaster');
  const input = { text: argument, author: event.chatter_user_name, authorId: event.chatter_user_id,
    messageId: event.message_id, source: 'twitch' };
  if (command === 'catchup') { session.catchupRequests++; return { kind: 'catchup', recap: recap(session) }; }
  if (command === 'moment') return { kind: 'nomination', item: nominate(session, input, now) };
  if (!moderator) return null;
  if (command === 'approve' || command === 'reject') {
    const [id, type = 'milestone', ...extra] = argument.split(/\s+/);
    if (extra.length) throw new Error('Use !approve <id> [type] or !reject <id>.');
    return { kind: 'moderation', item: moderate(session, id, command, type, now) };
  }
  return { kind: 'event', item: addEvent(session, { ...input, type: command }, now) };
}
export function loadDemo(state, now = Date.now()) {
  const session = newSession('One run. No shortcuts.', now - 36 * 60 * 1000);
  session.demo = true;
  state.sessions.push(session); state.activeId = session.id;
  const moments = [
    ['goal', 'Beat the summit without using a single checkpoint.', 'Mira', 0],
    ['rule', 'Every fall means a fresh run. No exceptions, even for the streamer.', 'mod_jules', 4],
    ['milestone', 'The first clean climb! We finally made it past the wind tunnel.', 'Mira', 12],
    ['joke', '“Trust the spoon” started when chat voted a kitchen spoon our lucky charm.', 'mod_jules', 18],
    ['milestone', 'Attempt 12 reached the final ridge. The summit is one jump away.', 'Mira', 29],
  ];
  for (const [type, content, author, minute] of moments) addEvent(session, { type, text: content, author }, session.startedAt + minute * 60000);
  nominate(session, { text: 'Chat named the last jump “the tax return” because nobody wants to do it.', author: 'pixelwitch' }, now - 120000);
  nominate(session, { text: 'We hit 12 attempts and still believe in the spoon.', author: 'mosslord' }, now - 45000);
  session.catchupRequests = 7;
  return session;
}
