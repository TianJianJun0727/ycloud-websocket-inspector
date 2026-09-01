export const MAX_PAYLOAD_CHARS = 1024 * 1024;

const EVENT_KEYS = ['key', 'event', 'type', 'method', 'action', 'topic'];

export function parseJsonPayload(payloadData, opcode = 1) {
  if (opcode !== 1 || typeof payloadData !== 'string') return null;
  try {
    return JSON.parse(payloadData);
  } catch {
    return null;
  }
}

export function inferEventName(payloadData, opcode = 1) {
  if (opcode !== 1) return 'binary';
  const normalized = String(payloadData).trim().toLowerCase();
  if (normalized === 'ping' || normalized === 'pong') return normalized;

  const parsed = parseJsonPayload(payloadData, opcode);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return 'message';

  for (const key of EVENT_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value) return value;
  }
  return 'json';
}

export function getPayloadByteSize(payloadData) {
  return new TextEncoder().encode(String(payloadData ?? '')).byteLength;
}

export function buildFrameRecord({
  id,
  direction,
  params,
  socketUrl,
  targetId,
  targetUrl,
  receivedAt = Date.now(),
}) {
  const originalPayload = String(params.response?.payloadData ?? '');
  const truncated = originalPayload.length > MAX_PAYLOAD_CHARS;
  const payloadData = truncated ? originalPayload.slice(0, MAX_PAYLOAD_CHARS) : originalPayload;

  return {
    id,
    direction,
    receivedAt,
    requestId: params.requestId,
    timestamp: params.timestamp,
    socketUrl: socketUrl || '',
    targetId,
    targetUrl,
    opcode: params.response?.opcode ?? 1,
    mask: Boolean(params.response?.mask),
    eventName: inferEventName(payloadData, params.response?.opcode),
    payloadData,
    payloadBytes: getPayloadByteSize(originalPayload),
    retainedPayloadBytes: getPayloadByteSize(payloadData),
    truncated,
  };
}

export function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
