export function mergeFrameBatch(currentFrames, incomingFrames, evictedFrameIds, maximum) {
  const evicted = new Set(evictedFrameIds || []);
  const byId = new Map();
  for (const frame of currentFrames) {
    if (!evicted.has(frame.id)) byId.set(frame.id, frame);
  }
  for (const frame of incomingFrames || []) {
    if (!evicted.has(frame.id)) byId.set(frame.id, frame);
  }
  const merged = [...byId.values()].sort((left, right) => left.id - right.id);
  return merged.length > maximum ? merged.slice(-maximum) : merged;
}

export function bucketFramesByConnection(frames) {
  const buckets = {};
  for (const frame of frames || []) {
    const key = frame.targetId + '::' + frame.requestId;
    (buckets[key] ||= []).push(frame);
  }
  return buckets;
}

export function mergeFrameBuckets(
  currentBuckets,
  incomingFrames,
  evictedFrameIds,
  maximumPerConnection,
) {
  const incomingBuckets = bucketFramesByConnection(incomingFrames);
  const keys = new Set([...Object.keys(currentBuckets || {}), ...Object.keys(incomingBuckets)]);
  const nextBuckets = {};
  for (const key of keys) {
    const merged = mergeFrameBatch(
      currentBuckets?.[key] || [],
      incomingBuckets[key] || [],
      evictedFrameIds,
      maximumPerConnection,
    );
    if (merged.length > 0) nextBuckets[key] = merged;
  }
  return nextBuckets;
}

export function orderRecentFrames(frames, sortOrder, limit) {
  const ordered = [...frames].sort((left, right) => {
    const capturedAtDifference = (left.receivedAt || 0) - (right.receivedAt || 0);
    if (capturedAtDifference !== 0) return capturedAtDifference;
    const protocolTimeDifference = (left.timestamp || 0) - (right.timestamp || 0);
    if (protocolTimeDifference !== 0) return protocolTimeDifference;
    return left.id - right.id;
  });
  const limited = ordered.slice(-limit);
  return sortOrder === 'asc' ? limited : limited.reverse();
}

function parseRegexFilter(query) {
  if (!query.startsWith('/')) return null;
  const lastSlash = query.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const pattern = query.slice(1, lastSlash);
  const flags = query.slice(lastSlash + 1);
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function matchesTextFilter(values, query, regexValue = values.at(-1)) {
  const normalized = query.trim();
  if (!normalized) return true;
  const regex = parseRegexFilter(normalized);
  if (regex) {
    regex.lastIndex = 0;
    return regex.test(String(regexValue || ''));
  }
  const text = normalized.toLowerCase();
  return values.some((value) =>
    String(value || '')
      .toLowerCase()
      .includes(text),
  );
}
