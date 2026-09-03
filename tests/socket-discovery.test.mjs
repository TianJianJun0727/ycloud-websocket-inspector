import { describe, expect, test } from 'bun:test';

import { reconcileRuntimeSockets } from '../src/lib/socket-discovery.ts';

const discoveredSocket = (url) => ({ url, readyState: 1 });

describe('runtime websocket discovery', () => {
    test('keeps four sockets per page target when two tabs use the same domain', () => {
        let nextId = 0;
        const discoverPage = () =>
            reconcileRuntimeSockets(
                [],
                Array.from({ length: 4 }, (_, index) => discoveredSocket(`wss://www-test.ycloud.com/ws/${index}`)),
                () => `runtime:${nextId++}`,
                100,
            );

        expect([...discoverPage(), ...discoverPage()]).toHaveLength(8);
    });

    test('preserves duplicate URLs as independent websocket connections', () => {
        let nextId = 0;
        const sockets = reconcileRuntimeSockets(
            [],
            [discoveredSocket('wss://example.com/ws'), discoveredSocket('wss://example.com/ws')],
            () => `runtime:${nextId++}`,
            100,
        );

        expect(sockets.map(({ requestId }) => requestId)).toEqual(['runtime:0', 'runtime:1']);
    });

    test('subtracts real CDP connections and reuses remaining placeholders', () => {
        const existing = [
            [
                'real:1',
                {
                    url: 'wss://example.com/ws',
                    createdAt: 50,
                    closedAt: null,
                    status: 'open',
                },
            ],
            [
                'runtime:1',
                {
                    url: 'wss://example.com/ws',
                    createdAt: 60,
                    closedAt: null,
                    status: 'open',
                    urlSource: 'runtime',
                },
            ],
        ];
        const sockets = reconcileRuntimeSockets(
            existing,
            [discoveredSocket('wss://example.com/ws'), discoveredSocket('wss://example.com/ws')],
            () => 'unexpected',
            100,
        );

        expect(sockets).toEqual([{ requestId: 'runtime:1', socket: existing[1][1] }]);
    });
});
