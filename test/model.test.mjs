import test from 'node:test';
import assert from 'node:assert/strict';
import { active, addEvent, applyChat, initialState, loadDemo, moderate, newSession, nominate, parseCommand, recap } from '../model.mjs';

function chat(message, moderator = false) {
  return { message: { text: message }, chatter_user_id: 'viewer-1', chatter_user_name: 'Viewer',
    broadcaster_user_id: 'streamer-1', badges: moderator ? [{ set_id: 'moderator' }] : [] };
}
test('commands require exact names and their expected arguments', () => {
  assert.deepEqual(parseCommand(' !GOAL Reach the summit '), { command: 'goal', argument: 'Reach the summit' });
  for (const input of ['!goals nope', 'hello !catchup', '!catchup now', '!goal', '!moment   ', '!approve']) assert.equal(parseCommand(input), null);
  assert.equal(parseCommand('!catchup').command, 'catchup');
});
test('unapproved viewer text cannot enter the recap', () => {
  const session = newSession('A stream', 0);
  assert.equal(applyChat(session, chat('!goal Unauthorized goal'), 1000), null);
  assert.equal(applyChat(session, { ...chat('!rule No rules'), badges: [{ set_id: 'vip' }] }, 1000), null);
  applyChat(session, chat('!moment A nominated highlight'), 2000);
  assert.equal(session.events.length, 0);
  assert.equal(recap(session).sources.length, 0);
  assert.equal(session.nominations.length, 1);
});
test('moderators can publish, broadcaster identity can publish without badges', () => {
  const session = newSession('A stream', 0);
  applyChat(session, chat('!goal Reach the summit', true), 1000);
  applyChat(session, { ...chat('!rule No checkpoints'), chatter_user_id: 'streamer-1' }, 2000);
  assert.equal(recap(session).goal.text, 'Reach the summit');
  assert.equal(recap(session).rule.text, 'No checkpoints');
});
test('approval retains nomination time and cannot be performed twice', () => {
  const session = newSession('A stream', 1000);
  const item = nominate(session, { text: 'The spoon!', author: 'A viewer' }, 61000);
  moderate(session, item.id.slice(0, 8), 'approve', 'joke', 120000);
  assert.equal(recap(session).joke.offset, 60);
  assert.equal(recap(session).joke.author, 'A viewer');
  assert.equal(recap(session).joke.nominationId, item.id);
  assert.throws(() => moderate(session, item.id, 'approve', 'joke'), /not found/);
});
test('rejected nominations stay out and invalid moderation does not consume a nomination', () => {
  const session = newSession();
  const item = nominate(session, { text: 'A moment' });
  assert.throws(() => moderate(session, item.id, 'approve', 'invalid'), /valid moment type/);
  assert.equal(item.status, 'pending');
  moderate(session, item.id, 'reject');
  assert.equal(recap(session).sources.length, 0);
});
test('old nominations do not replace newer context when approved later', () => {
  const session = newSession('A stream', 0);
  const item = nominate(session, { text: 'Attempt 1', author: 'viewer' }, 1000);
  addEvent(session, { type: 'milestone', text: 'Attempt 12' }, 20000);
  moderate(session, item.id, 'approve', 'milestone', 30000);
  assert.equal(recap(session).milestone.text, 'Attempt 12');
});
test('duplicate and excessive viewer nominations are bounded', () => {
  const session = newSession();
  nominate(session, { text: 'One', authorId: 'v' });
  assert.throws(() => nominate(session, { text: 'one', authorId: 'v' }), /already nominated/);
  nominate(session, { text: 'Two', authorId: 'v' });
  nominate(session, { text: 'Three', authorId: 'v' });
  assert.throws(() => nominate(session, { text: 'Four', authorId: 'v' }), /three pending/);
});
test('recap uses latest approved entry per type, with traceable source IDs', () => {
  const session = newSession('A stream', 0);
  addEvent(session, { type: 'goal', text: 'Old goal' }, 1000);
  const latest = addEvent(session, { type: 'goal', text: 'New goal' }, 2000);
  assert.equal(recap(session).sources.length, 1);
  assert.equal(recap(session).goal.id, latest.id);
  assert.ok(!recap(session).text.includes('Old goal'));
  applyChat(session, chat('!catchup'));
  assert.equal(session.catchupRequests, 1);
});
test('demo creates a separate session without overwriting a real stream', () => {
  const state = initialState(), original = active(state);
  addEvent(original, { type: 'goal', text: 'Real stream' });
  loadDemo(state);
  assert.equal(state.sessions.length, 2);
  assert.equal(active(state).demo, true);
  assert.equal(original.events[0].text, 'Real stream');
  assert.equal(recap(active(state)).sources.length, 4);
});
