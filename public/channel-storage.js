const prefix = 'supra:channel:';

export function readChannel(channelId, storage = localStorage) {
  const saved = storage.getItem(prefix + channelId);
  if (saved === null) return null;
  const snapshot = JSON.parse(saved);
  if (!snapshot || snapshot.version !== 1 || snapshot.channelId !== channelId || !snapshot.state) {
    throw new Error('Saved browser data does not match this channel.');
  }
  return snapshot;
}

export function saveChannel(data, storage = localStorage) {
  // Never replace a browser backup with the empty workspace returned before hydration.
  if (!data.authenticated || data.needsRestore || !data.backup) return;
  const key = prefix + data.channelId, serialized = JSON.stringify(data.backup);
  if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
}
