// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CircularBuffer - Fixed-size buffer for MUD output with sequence numbering
 *
 * Uses a ring buffer with head/tail pointers for O(1) append and eviction.
 * When buffer reaches capacity, oldest chunks are dropped (wrap-around).
 */

import type { BufferChunk } from './types';
import { withDefaults } from './with-defaults';

const CHUNK_OVERHEAD_ESTIMATE = 256;

export class CircularBuffer {
  private chunks: (BufferChunk | null)[];
  private head = 0; // index of oldest element
  private tail = 0; // index of next write position
  private count = 0;
  private currentSize = 0;
  private readonly maxSize: number;
  private readonly capacity: number;
  private sequenceCounter = 0;
  private sequenceIndex: Map<number, number> = new Map();

  constructor(maxSizeBytes: number, initialCapacity = 1024) {
    this.maxSize = maxSizeBytes;
    this.capacity = initialCapacity;
    this.chunks = new Array(initialCapacity).fill(null);
  }

  /**
   * Add data to the buffer with a new sequence number
   * Drops oldest chunks if necessary to stay within size limit
   */
  append(
    data: Buffer,
    type: 'data' | 'gmcp' | 'echo',
    metadata?: Partial<BufferChunk>,
  ): BufferChunk {
    const chunk: BufferChunk = withDefaults(
      {
        sequence: ++this.sequenceCounter,
        timestamp: Date.now(),
        data,
        type,
      },
      metadata,
    );

    const chunkSize = data.length + CHUNK_OVERHEAD_ESTIMATE;

    // A chunk larger than the whole buffer can never fit. Previously the
    // eviction loop below emptied the buffer trying to make room and then
    // stored it anyway, so a 10 KiB buffer held 64 KiB — over its limit by
    // 6.4x, with the replay history discarded for nothing. Refuse it and keep
    // what is already there (MWP-93).
    if (chunkSize > this.maxSize) {
      return chunk;
    }

    // Remove oldest chunks until we have room
    while (this.currentSize + chunkSize > this.maxSize && this.count > 0) {
      const oldest = this.chunks[this.head];
      if (oldest) {
        this.currentSize -= oldest.data.length + CHUNK_OVERHEAD_ESTIMATE;
        this.sequenceIndex.delete(oldest.sequence);
        this.chunks[this.head] = null;
      }
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }

    // If buffer is full (all slots used), evict oldest
    if (this.count === this.capacity) {
      const oldest = this.chunks[this.head];
      if (oldest) {
        this.currentSize -= oldest.data.length + CHUNK_OVERHEAD_ESTIMATE;
        this.sequenceIndex.delete(oldest.sequence);
      }
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }

    this.chunks[this.tail] = chunk;
    this.sequenceIndex.set(chunk.sequence, this.tail);
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    this.currentSize += chunkSize;

    return chunk;
  }

  /**
   * Get every chunk *strictly after* a sequence number.
   *
   * The argument is what a client has already received, so it must not be
   * sent back. This was `replayFrom` and was inclusive, which meant every
   * resume re-delivered the last frame the client already had — the MUD's
   * final line rendered twice on every reconnect. The iOS client
   * (ProxyConnectionService.swift) stores each frame's seq as it arrives and
   * sends that value as `lastSeq`, and it neither decodes the `replayed`
   * flag nor deduplicates, so it had no way to suppress the repeat.
   *
   * Named `replayAfter` rather than `replayFrom` because the old name read
   * as inclusive and the boundary is the whole point of the method.
   *
   * Uses sequenceIndex for O(1) lookup of the starting position, falling back
   * to a scan when the sequence has been evicted.
   */
  replayAfter(sequence: number): BufferChunk[] {
    if (this.count === 0) {
      return [];
    }

    // Find the offset of the first chunk to return.
    let startOffset = 0;
    const arrayIdx = this.sequenceIndex.get(sequence);
    if (arrayIdx !== undefined) {
      // O(1) lookup lands on the acknowledged chunk itself; start past it.
      startOffset =
        ((arrayIdx - this.head + this.capacity) % this.capacity) + 1;
      if (startOffset >= this.count) {
        return [];
      }
    } else {
      // Evicted or never existed — find the first chunk strictly newer.
      let found = false;
      for (let i = 0; i < this.count; i++) {
        const idx = (this.head + i) % this.capacity;
        const chunk = this.chunks[idx];
        if (chunk && chunk.sequence > sequence) {
          startOffset = i;
          found = true;
          break;
        }
      }
      if (!found) {
        return [];
      }
    }

    const result: BufferChunk[] = [];
    for (let i = startOffset; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      const chunk = this.chunks[idx];
      if (chunk) {
        result.push(chunk);
      }
    }
    return result;
  }

  /**
   * Get the current sequence number
   */
  getCurrentSequence(): number {
    return this.sequenceCounter;
  }

  /**
   * Get the most recent sequence number in buffer
   */
  getLastSequence(): number {
    if (this.count === 0) {
      return 0;
    }
    const lastIdx = (this.tail - 1 + this.capacity) % this.capacity;
    return this.chunks[lastIdx]?.sequence ?? 0;
  }

  /**
   * Get total size of buffer in bytes
   */
  getSize(): number {
    return this.currentSize;
  }

  /**
   * Get number of chunks in buffer
   */
  getChunkCount(): number {
    return this.count;
  }

  /**
   * Check if a sequence number is still in the buffer
   */
  hasSequence(sequence: number): boolean {
    if (this.count === 0) {
      return false;
    }
    const oldest = this.chunks[this.head];
    const lastIdx = (this.tail - 1 + this.capacity) % this.capacity;
    const newest = this.chunks[lastIdx];
    return (
      !!oldest &&
      !!newest &&
      sequence >= oldest.sequence &&
      sequence <= newest.sequence
    );
  }

  /**
   * Clear all data from buffer
   */
  clear(): void {
    this.chunks = new Array(this.capacity).fill(null);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.currentSize = 0;
    this.sequenceIndex.clear();
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    chunks: number;
    sizeBytes: number;
    maxSizeBytes: number;
    currentSequence: number;
    oldestSequence: number;
    newestSequence: number;
  } {
    const oldest =
      this.count > 0 ? (this.chunks[this.head]?.sequence ?? 0) : 0;
    return {
      chunks: this.count,
      sizeBytes: this.currentSize,
      maxSizeBytes: this.maxSize,
      currentSequence: this.sequenceCounter,
      oldestSequence: oldest,
      newestSequence: this.getLastSequence(),
    };
  }
}
