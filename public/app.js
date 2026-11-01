import { readChannel, saveChannel } from './channel-storage.js';

const $ = (selector) => document.querySelector(selector);
const labels = { goal: 'Goal', milestone: 'Milestone', joke: 'Inside joke', rule: 'Stream rule' };
const symbols = { goal: '◎', milestone: '⚑', joke: '✳', rule: '◇' };
const recapLabels = {
  goal: 'The mission',
  milestone: 'Where we are now',
  rule: 'The rule to know',
  joke: 'Why chat keeps saying that',
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const elapsed = (seconds) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
let state,
  config,
  filter = 'all',
  view = 'all',
  sessionAction = 'new',
  toastTimer,
  pendingRemoval;
const failedStorage = new Set(),
  restoring = new Map();

function toast(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      $('#toast').hidden = true;
    },
    error ? 7000 : 4000,
  );
}
async function api(path, data) {
  const response = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status });
  return result;
}
async function action(data) {
  const result = await api('/api/action', data);
  await receive(result);
  return result;
}
function storageProblem(channelId) {
  failedStorage.add(channelId);
  toast(
    'Browser saving is unavailable. Existing backups were left untouched. Use Export your streams to keep this session.',
    true,
  );
}
async function receive(data) {
  if (state?.serverId === data.serverId) {
    if (data.browserGeneration < state.browserGeneration) return;
    if (
      data.browserGeneration === state.browserGeneration &&
      data.channelId === state.channelId &&
      data.revision < state.revision
    )
      return;
  }
  if (data.authenticated && data.needsRestore) {
    const key = `${data.serverId}:${data.browserGeneration}:${data.channelId}`;
    if (!restoring.has(key)) {
      const restore = (async () => {
        let snapshot = null;
        try {
          snapshot = readChannel(data.channelId);
        } catch {
          storageProblem(data.channelId);
        }
        let restored;
        try {
          restored = await api('/api/restore', { snapshot });
        } catch (error) {
          if (!snapshot || error.status !== 400) throw error;
          storageProblem(data.channelId);
          restored = await api('/api/restore', { snapshot: null });
        }
        await receive(restored);
      })();
      restoring.set(key, restore);
    }
    try {
      await restoring.get(key);
    } finally {
      restoring.delete(key);
    }
    return;
  }
  if (!failedStorage.has(data.channelId)) {
    try {
      saveChannel(data);
    } catch {
      storageProblem(data.channelId);
    }
  }
  render(data);
}
function run(operation) {
  return async (event) => {
    event?.preventDefault();
    const button =
      event?.currentTarget instanceof HTMLButtonElement
        ? event.currentTarget
        : event?.currentTarget?.querySelector('button[type="submit"], button:not([type])');
    if (button) button.disabled = true;
    try {
      await operation(event);
    } catch (error) {
      toast(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  };
}
function renderTimeline() {
  if (!state) return;
  const query = $('#search').value.trim().toLowerCase();
  const events = [...state.session.events]
    .sort((a, b) => b.at - a.at)
    .filter(
      (item) =>
        (filter === 'all' || filter === item.type) &&
        (view !== 'community' || item.source === 'twitch' || item.nominationId) &&
        (!query || `${item.text} ${item.author}`.toLowerCase().includes(query)),
    );
  $('#moment-count').textContent = events.length;
  $('#timeline').innerHTML = events.length
    ? events
        .map(
          (item) => `
    <article class="moment" data-type="${escape(item.type)}" id="moment-${escape(item.id)}">
      <span class="moment-dot" aria-hidden="true">${symbols[item.type]}</span>
      <div class="moment-meta"><span class="type-label">${labels[item.type]}</span><time datetime="${new Date(item.at).toISOString()}">${elapsed(item.offset)}</time><button class="moment-remove" data-remove="${escape(item.id)}" aria-label="Remove moment">Remove</button></div>
      <p class="moment-text">${escape(item.text)}</p>
      <div class="moment-credit"><span class="avatar">${escape(item.author.slice(0, 1))}</span>${escape(item.author)}${item.nominationId ? '<span class="community-pill">COMMUNITY PICK</span>' : ''}<span>· ${item.source === 'twitch' ? 'Twitch chat' : state.session.demo ? 'Demo stream' : 'Studio'}</span></div>
    </article>`,
        )
        .join('')
    : `
    <div class="empty-state"><span aria-hidden="true">↶</span><h3>${state.session.events.length ? 'No moments in this chapter.' : 'The good bits belong here.'}</h3><p>${state.session.events.length ? 'Try another filter or search to find your moment.' : 'Save a goal, a turning point, or the joke everyone keeps repeating. New arrivals will thank you.'}</p>${state.session.events.length ? '' : '<button class="button primary small" data-start-story>＋ Add the first moment</button>'}</div>`;
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.filter === filter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  });
}
function render(data) {
  state = data;
  const { session, recap, status } = data;
  $('#session-title').textContent = session.title;
  $('#session-age').textContent =
    `${new Date(session.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${elapsed(Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000)))} into the story`;
  $('#session-badge').textContent = session.demo ? 'DEMO' : status.connected ? 'TWITCH' : 'STUDIO';
  $('#session-badge').classList.toggle('demo', Boolean(session.demo));
  $('#connection').classList.toggle('connected', status.connected);
  $('#connection span').textContent = status.message;
  $('#connect').textContent = data.authenticated ? 'Disconnect' : 'Connect Twitch ↗';
  $('#reconnect').hidden = !data.authenticated || Boolean(status.login);
  $('#storage-status').textContent = data.authenticated
    ? failedStorage.has(data.channelId)
      ? 'Browser save unavailable · export to keep'
      : 'Saved in this browser for your channel'
    : 'Private demo · connect to save';
  $('#obs-overlay').href = data.overlayPath;
  $('#copy-overlay').disabled = !data.authenticated;
  $('#copy-overlay').title = data.authenticated
    ? 'Copy your read-only overlay URL for OBS.'
    : 'Connect Twitch to get your channel’s OBS URL.';
  $('#sessions').innerHTML = [...data.sessions]
    .reverse()
    .map(
      (item) =>
        `<option value="${escape(item.id)}" ${item.id === session.id ? 'selected' : ''}>${item.demo ? 'Demo · ' : ''}${escape(item.title)}</option>`,
    )
    .join('');
  $('#sessions').disabled = false;
  $('#sessions').title = status.login
    ? 'Switching streams pauses Twitch chat.'
    : 'Switch saved stream';
  $('#total-count').textContent = session.events.length;
  $('#current-goal').textContent = recap.goal?.text || "What's the goal today?";
  $('#goal-hint').textContent = recap.goal
    ? `Set by ${recap.goal.author} at ${elapsed(recap.goal.offset)} · Every new viewer starts with the mission.`
    : "Add a goal so new viewers know what we're working toward.";
  $('#recap-content').innerHTML = recap.sources.length
    ? recap.sources
        .map(
          (item) => `
    <section class="recap-item"><div><h3>${recapLabels[item.type]}</h3><a class="recap-source" href="#moment-${escape(item.id)}" data-source="${escape(item.id)}">${elapsed(item.offset)} ↗</a></div><p>${escape(item.text)}</p></section>`,
        )
        .join('')
    : '<p class="recap-empty">A little context goes a long way. Add your first moment to start the catch-up.</p>';
  $('#copy-recap').disabled = !recap.sources.length;
  $('#replies').checked = data.replies;
  $('#replies').disabled = !status.connected || !status.canReply || Boolean(session.demo);
  $('#replies').title = status.canReply
    ? ''
    : 'Connect with optional chat write permission to enable replies.';
  $('#catchup-activity').textContent = data.lastCatchup
    ? `${data.lastCatchup.author} asked for a catch-up · ${data.lastCatchup.sent ? 'replied in Twitch' : 'preview updated'} · ${session.catchupRequests} requests this stream`
    : `${session.catchupRequests || 'No'} catch-up requests this stream`;
  const pending = session.nominations
    .filter((item) => item.status === 'pending')
    .sort((a, b) => b.at - a.at);
  $('#queue-count').textContent = pending.length;
  $('#queue').innerHTML = pending.length
    ? pending
        .map(
          (item) => `
    <article class="nomination" data-id="${escape(item.id)}"><div class="nomination-meta"><span>${escape(item.author)}</span><code>#${escape(item.id.slice(0, 8))}</code></div><p>${escape(item.text)}</p><div class="nomination-actions"><select aria-label="Moment type for nomination by ${escape(item.author)}">${Object.entries(
      labels,
    )
      .map(
        ([type, label]) =>
          `<option value="${type}" ${type === 'milestone' ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select><button data-decision="approve">✓ Keep</button><button class="reject" data-decision="reject" aria-label="Dismiss nomination">×</button></div></article>`,
        )
        .join('')
    : '<div class="queue-empty">All caught up.<br>New <code>!moment</code> nominations will land here.</div>';
  $('#simulate-form').hidden = !session.demo;
  $('#load-demo').disabled = data.authenticated;
  $('#load-demo').textContent = session.demo ? 'Reload demo ↗' : 'Load demo stream ↗';
  renderTimeline();
}

function openCapture() {
  $('#capture-dialog').showModal();
  $('#moment-text').focus();
}
$('#open-capture').onclick = openCapture;
document.querySelectorAll('.close-dialog').forEach((button) => {
  button.onclick = () => button.closest('dialog').close();
});
$('#show-commands').onclick = () => $('#commands-dialog').showModal();
document.querySelectorAll('[data-filter]').forEach((button) => {
  button.onclick = () => {
    filter = button.dataset.filter;
    renderTimeline();
  };
});
document.querySelectorAll('[data-view]').forEach((button) => {
  button.onclick = () => {
    view = button.dataset.view;
    renderTimeline();
  };
});
$('#search').oninput = renderTimeline;
$('#capture-form').onsubmit = run(async () => {
  await action({ action: 'add', type: $('#moment-type').value, text: $('#moment-text').value });
  $('#capture-dialog').close();
  $('#moment-text').value = '';
  toast('Added to the story.');
});
function sessionDialog(action) {
  sessionAction = action;
  $('#session-dialog-title').textContent =
    action === 'new' ? 'Start a new stream' : 'Name this chapter';
  $('#save-session').textContent = action === 'new' ? 'Start the story ↗' : 'Save name';
  $('#stream-title').value = action === 'rename' ? state.session.title : '';
  $('#session-dialog').showModal();
  $('#stream-title').focus();
}
$('#new-stream').onclick = () => sessionDialog('new');
$('#rename').onclick = () => sessionDialog('rename');
$('#session-form').onsubmit = run(async () => {
  await action({ action: sessionAction, title: $('#stream-title').value });
  $('#session-dialog').close();
  toast(sessionAction === 'new' ? 'A new chapter. Previous streams are saved.' : 'Stream renamed.');
});
$('#sessions').onchange = run(async () => {
  await action({ action: 'switch', id: $('#sessions').value });
});
$('#load-demo').onclick = run(async () => {
  await action({ action: 'demo' });
  toast('Demo loaded. Try !moment or !catchup below the timeline.');
});
$('#simulate-form').onsubmit = run(async () => {
  await receive(
    await api('/api/simulate', {
      message: $('#simulate').value,
      moderator: $('#demo-moderator').checked,
    }),
  );
  $('#simulate').value = '';
  toast('Demo command received.');
});
$('#queue').onclick = run(async (event) => {
  const button = event.target.closest('[data-decision]');
  if (!button) return;
  const card = button.closest('.nomination');
  await action({
    action: 'moderate',
    id: card.dataset.id,
    decision: button.dataset.decision,
    type: card.querySelector('select').value,
  });
  toast(
    button.dataset.decision === 'approve'
      ? 'Moment approved. The catch-up is updated.'
      : 'Nomination dismissed.',
  );
});
$('#timeline').onclick = run(async (event) => {
  if (event.target.closest('[data-start-story]')) {
    openCapture();
    return;
  }
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  if (pendingRemoval !== button.dataset.remove) {
    pendingRemoval = button.dataset.remove;
    button.textContent = 'Remove? Click again';
    setTimeout(() => {
      if (button.isConnected) button.textContent = 'Remove';
      pendingRemoval = null;
    }, 4000);
    return;
  }
  await action({ action: 'remove', id: button.dataset.remove });
  pendingRemoval = null;
  toast('Moment removed from the timeline and catch-up.');
});
$('#recap-content').onclick = (event) => {
  const link = event.target.closest('[data-source]');
  if (!link) return;
  event.preventDefault();
  filter = 'all';
  view = 'all';
  $('#search').value = '';
  renderTimeline();
  const moment = document.getElementById(`moment-${link.dataset.source}`);
  moment?.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'center',
  });
  moment?.classList.add('highlight');
};
$('#copy-recap').onclick = run(async () => {
  try {
    await navigator.clipboard.writeText(state.recap.text);
    toast('Catch-up copied.');
  } catch {
    toast('Clipboard unavailable. Select and copy the catch-up text directly.', true);
  }
});
$('#replies').onchange = run(async () => {
  try {
    await receive(await api('/api/replies', { enabled: $('#replies').checked }));
  } catch (error) {
    $('#replies').checked = state.replies;
    throw error;
  }
});
async function connectDialog() {
  config = await api('/api/config');
  $('#redirect-url').textContent = config.redirectUri;
  $('#authorize').disabled = !config.clientId;
  $('#setup-dialog').showModal();
}
$('#connect').onclick = run(async () => {
  if (state.authenticated) {
    await receive(await api('/api/disconnect', {}));
    toast('Disconnected. Connect Twitch in this browser to reopen your saved channel.');
    return;
  }
  await connectDialog();
});
$('#reconnect').onclick = run(connectDialog);
$('#copy-overlay').onclick = run(async () => {
  await navigator.clipboard.writeText(new URL(state.overlayPath, location.origin).href);
  toast('Overlay URL copied. Paste it into an OBS Browser Source.');
});
$('#authorize').onclick = run(async () => {
  const nonce = crypto.randomUUID();
  sessionStorage.setItem('supra-oauth-state', nonce);
  const scopes = ['user:read:chat'];
  if ($('#request-write').checked) scopes.push('user:write:chat');
  location.href = `https://id.twitch.tv/oauth2/authorize?${new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'token',
    scope: scopes.join(' '),
    state: nonce,
  })}`;
});
async function authorize() {
  const parameters = new URLSearchParams(location.hash.slice(1));
  if (!parameters.has('access_token') && !parameters.has('error')) return;
  history.replaceState(null, '', '/');
  const expected = sessionStorage.getItem('supra-oauth-state');
  sessionStorage.removeItem('supra-oauth-state');
  if (!expected || parameters.get('state') !== expected)
    throw new Error('Authorization state mismatch. Connect again.');
  if (parameters.has('error')) throw new Error('Twitch authorization was canceled.');
  await receive(await api('/api/connect', { token: parameters.get('access_token') }));
  toast('Connecting to your channel. Real chat uses its own saved stream.');
}

try {
  await receive(await api('/api/state'));
  const events = new EventSource('/api/events');
  events.addEventListener('state', (event) => {
    receive(JSON.parse(event.data)).catch((error) => toast(error.message, true));
  });
  events.addEventListener('notice', (event) => toast(JSON.parse(event.data).message, true));
  events.onerror = () => {
    $('#connection span').textContent = 'Studio disconnected. Reconnecting…';
    $('#connection').classList.remove('connected');
  };
  await authorize();
} catch (error) {
  toast(error.message, true);
}
