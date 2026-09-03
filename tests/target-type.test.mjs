import { describe, expect, test } from 'bun:test';

import { resolveWebSocketTargetType } from '../src/lib/target-type.ts';

describe('websocket target type', () => {
    test('prioritizes a SharedWorker runtime over Chrome generic worker type', () => {
        expect(resolveWebSocketTargetType('worker', { scopeType: 'shared_worker' })).toBe('shared_worker');
        expect(resolveWebSocketTargetType('worker', { scopeName: 'SharedWorkerGlobalScope' })).toBe('shared_worker');
    });

    test('keeps page and Dedicated Worker targets independent', () => {
        expect(resolveWebSocketTargetType('page', undefined)).toBe('page');
        expect(resolveWebSocketTargetType('worker', { scopeType: 'worker' })).toBe('worker');
    });

    test('recognizes SharedWorker exposed as an other target', () => {
        expect(resolveWebSocketTargetType('other', { scopeType: 'shared_worker' })).toBe('shared_worker');
    });
});
