/**
 * The output buffer must honour its own cap (MWP-93 item 5).
 *
 * `append` evicts oldest chunks until the new one fits — but the loop is
 * guarded by `count > 0`, so a single chunk larger than the whole buffer
 * evicted everything and was then stored anyway. Measured before the fix: a
 * 10 KiB buffer held 64 KiB, over its limit by 6.4x.
 *
 * Bounded in practice by the TCP read size, so this was never unbounded — but
 * a cap that a single write can exceed is not a cap, and it is multiplied by
 * the session limit.
 */

import { describe, expect, test } from 'bun:test';
import { CircularBuffer } from '../src/circular-buffer.js';

const size = (b: CircularBuffer): number =>
  (b as unknown as { currentSize: number }).currentSize;

describe('a single oversized chunk cannot exceed the cap', () => {
  test('an over-large chunk is refused rather than stored', () => {
    const max = 10 * 1024;
    const b = new CircularBuffer(max);
    b.append(Buffer.alloc(1024), 'data');
    b.append(Buffer.alloc(64 * 1024), 'data');

    expect(size(b)).toBeLessThanOrEqual(max);
  });

  test('refusing the oversized chunk does not discard the useful history', () => {
    // Evicting everything to make room for something that will not fit anyway
    // loses the replay history and gains nothing.
    const max = 10 * 1024;
    const b = new CircularBuffer(max);
    b.append(Buffer.from('keep me'), 'data');
    b.append(Buffer.alloc(64 * 1024), 'data');

    const replayed = b.replayAfter(0);
    expect(replayed.some((c) => c.data.toString() === 'keep me')).toBe(true);
  });
});

describe('ordinary appends still evict to stay within the cap', () => {
  test('many in-bounds chunks stay bounded', () => {
    const max = 8 * 1024;
    const b = new CircularBuffer(max);
    for (let i = 0; i < 500; i++) b.append(Buffer.alloc(512), 'data');

    expect(size(b)).toBeLessThanOrEqual(max);
  });

  test('the newest chunk is always retained', () => {
    const max = 4 * 1024;
    const b = new CircularBuffer(max);
    for (let i = 0; i < 50; i++) b.append(Buffer.from(`chunk-${i}`), 'data');

    const replayed = b.replayAfter(0);
    expect(replayed.at(-1)?.data.toString()).toBe('chunk-49');
  });
});
