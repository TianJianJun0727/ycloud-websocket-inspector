import { describe, expect, test } from 'bun:test';
import {
  bucketFramesByConnection,
  getVirtualWindow,
  isActiveDiagnostic,
  matchesTextFilter,
  mergeFrameBatch,
  mergeFrameBuckets,
  orderRecentFrames,
  resolveConnectionRecords,
} from '../inspector-utils.js';

describe('inspector utils', () => {
  test('merges batches without duplicating snapshot frames', () => {
    const merged = mergeFrameBatch([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], [], 20);
    expect(merged.map((frame) => frame.id)).toEqual([1, 2, 3]);
  });

  test('applies explicit eviction and total capacity', () => {
    const merged = mergeFrameBatch([{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [2], 2);
    expect(merged.map((frame) => frame.id)).toEqual([3, 4]);
  });

  test('keeps every websocket connection attempt in an independent bucket', () => {
    const buckets = bucketFramesByConnection([
      { id: 1, targetId: 'worker', requestId: 'socket-1' },
      { id: 2, targetId: 'worker', requestId: 'socket-2' },
      { id: 3, targetId: 'worker', requestId: 'socket-1' },
    ]);
    expect(Object.keys(buckets)).toEqual(['worker::socket-1', 'worker::socket-2']);
    expect(buckets['worker::socket-1'].map((frame) => frame.id)).toEqual([1, 3]);
    expect(buckets['worker::socket-2'].map((frame) => frame.id)).toEqual([2]);
  });

  test('merges and evicts frames without crossing connection buckets', () => {
    const merged = mergeFrameBuckets(
      {
        'worker::socket-1': [{ id: 1, targetId: 'worker', requestId: 'socket-1' }],
        'worker::socket-2': [{ id: 2, targetId: 'worker', requestId: 'socket-2' }],
      },
      [{ id: 3, targetId: 'worker', requestId: 'socket-1' }],
      [1],
      10,
    );
    expect(merged['worker::socket-1'].map((frame) => frame.id)).toEqual([3]);
    expect(merged['worker::socket-2'].map((frame) => frame.id)).toEqual([2]);
  });

  test('supports substring and regex filters', () => {
    expect(matchesTextFilter(['Hello WebSocket'], 'websocket')).toBe(true);
    expect(matchesTextFilter(['message-1024'], '/message-\\d+/i')).toBe(true);
    expect(matchesTextFilter(['message-1024'], '/invalid[/')).toBe(false);
  });

  test('applies regex filters only to the websocket payload', () => {
    const excludeHeartbeat = '/^(?!ping$)(?!pong$).*/';
    expect(
      matchesTextFilter(
        ['ws://localhost:8787/inbox', 'localhost:3091/inbox-shared-worker.js', 'ping'],
        excludeHeartbeat,
      ),
    ).toBe(false);
    expect(
      matchesTextFilter(
        ['ws://localhost:8787/inbox', 'localhost:3091/inbox-shared-worker.js', 'pong'],
        excludeHeartbeat,
      ),
    ).toBe(false);
    expect(
      matchesTextFilter(
        [
          'ws://localhost:8787/inbox',
          'localhost:3091/inbox-shared-worker.js',
          '{"type":"message.created"}',
        ],
        excludeHeartbeat,
      ),
    ).toBe(true);
  });

  test('keeps regex flags explicit', () => {
    expect(matchesTextFilter(['PING'], '/ping/')).toBe(false);
    expect(matchesTextFilter(['PING'], '/ping/i')).toBe(true);
  });

  test('sorts the recent render window in both time directions', () => {
    const frames = [
      { id: 4, receivedAt: 400 },
      { id: 2, receivedAt: 200 },
      { id: 1, receivedAt: 100 },
      { id: 3, receivedAt: 300 },
    ];
    expect(orderRecentFrames(frames, 'asc', 3).map((frame) => frame.id)).toEqual([2, 3, 4]);
    expect(orderRecentFrames(frames, 'desc', 3).map((frame) => frame.id)).toEqual([4, 3, 2]);
  });

  test('uses protocol time and id to order frames captured in the same millisecond', () => {
    const frames = [
      { id: 3, receivedAt: 100, timestamp: 2 },
      { id: 1, receivedAt: 100, timestamp: 1 },
      { id: 2, receivedAt: 100, timestamp: 1 },
    ];
    expect(orderRecentFrames(frames, 'asc', 10).map((frame) => frame.id)).toEqual([1, 2, 3]);
  });

  test('virtualizes a large connection without changing its total row count', () => {
    const window = getVirtualWindow(100000, 42000, 420, 42, 12);
    expect(window).toEqual({
      startIndex: 988,
      endIndex: 1022,
      topSpacerHeight: 41496,
      bottomSpacerHeight: 4157076,
    });
    expect(window.endIndex - window.startIndex).toBe(34);
  });

  test('clamps stale scroll positions after a filter reduces the row count', () => {
    expect(getVirtualWindow(10, 420000, 420, 42, 12)).toEqual({
      startIndex: 0,
      endIndex: 10,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    });
  });

  test('keeps an explicit empty connection snapshot after a capture reset', () => {
    const staleFallback = [{ key: 'closed-connection' }];
    expect(resolveConnectionRecords([], staleFallback)).toEqual([]);
    expect(resolveConnectionRecords(null, staleFallback)).toEqual(staleFallback);
  });

  test('expires transient capture diagnostics without expiring persistent storage errors', () => {
    expect(isActiveDiagnostic({ expiresAt: 1100 }, 1000)).toBe(true);
    expect(isActiveDiagnostic({ expiresAt: 900 }, 1000)).toBe(false);
    expect(isActiveDiagnostic({ expiresAt: null }, 1000)).toBe(true);
  });
});
