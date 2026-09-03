import { describe, expect, test } from 'bun:test';

import { displayDomain } from '../src/entrypoints/inspector/inspector-helpers.ts';

describe('inspector helpers', () => {
    test('shows the owner domain for regular page URLs', () => {
        expect(displayDomain('https://www.ycloud.com/console/')).toBe('www.ycloud.com');
    });

    test('shows the owner domain for blob worker URLs', () => {
        expect(displayDomain('blob:https://www.ycloud.com/worker-id')).toBe('www.ycloud.com');
    });
});
