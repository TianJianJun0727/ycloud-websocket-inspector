import { describe, expect, test } from 'bun:test';
import {
  MAX_PAYLOAD_CHARS,
  buildFrameRecord,
  formatByteSize,
  inferEventName,
} from '../frame-utils.js';

describe('frame utils', () => {
  test('infers common JSON event fields', () => {
    expect(inferEventName('{"type":"message.updated"}')).toBe('message.updated');
    expect(inferEventName('{"event":"conversation.changed"}')).toBe('conversation.changed');
  });

  test('recognizes heartbeat and binary frames', () => {
    expect(inferEventName('ping')).toBe('ping');
    expect(inferEventName('ignored', 2)).toBe('binary');
  });

  test('records byte size and truncates oversized payloads', () => {
    const record = buildFrameRecord({
      id: 1,
      direction: 'received',
      params: {
        requestId: 'socket-1',
        timestamp: 1,
        response: { opcode: 1, mask: false, payloadData: 'a'.repeat(MAX_PAYLOAD_CHARS + 5) },
      },
      targetId: 'target-1',
      targetUrl: 'https://example.com/shared-worker.js',
    });

    expect(record.payloadData.length).toBe(MAX_PAYLOAD_CHARS);
    expect(record.payloadBytes).toBe(MAX_PAYLOAD_CHARS + 5);
    expect(record.retainedPayloadBytes).toBe(MAX_PAYLOAD_CHARS);
    expect(record.truncated).toBe(true);
  });

  test('formats byte sizes', () => {
    expect(formatByteSize(17)).toBe('17 B');
    expect(formatByteSize(2048)).toBe('2.0 KB');
  });
});
