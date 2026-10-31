const labels = { goal: 'The mission', milestone: 'Where we are now', rule: 'The rule', joke: 'The inside joke' };
const elapsed = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
function render(data) {
  document.querySelector('#eyebrow').textContent = data.session?.demo ? 'DEMO · THE STORY SO FAR' : 'THE STORY SO FAR';
  const root = document.querySelector('#moments');
  root.replaceChildren();
  if (!data.recap.sources.length) {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'The story is just starting. Approved moments will appear here.';
    root.append(paragraph);
  }
  for (const item of data.recap.sources) {
    const section = document.createElement('section'), heading = document.createElement('h2');
    const time = document.createElement('time'), paragraph = document.createElement('p');
    heading.textContent = labels[item.type];
    time.textContent = elapsed(item.offset); heading.append(time);
    paragraph.textContent = item.text;
    section.append(heading, paragraph); root.append(section);
  }
  document.querySelector('#status').textContent = '';
}
const overlayKey = /^\/overlay\/([a-f0-9]{64})$/.exec(location.pathname)?.[1];
function connect() {
  const events = new EventSource(`/api/overlay-events${overlayKey ? `/${overlayKey}` : ''}`);
  events.addEventListener('state', event => render(JSON.parse(event.data)));
  events.onerror = () => {
    events.close();
    document.querySelector('#status').textContent = 'Waiting for the studio. Open it and reconnect Twitch after a restart.';
    setTimeout(connect, 3000);
  };
}
connect();
