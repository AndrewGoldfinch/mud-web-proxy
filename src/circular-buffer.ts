/**
 * CircularBuffer - Fixed-size buffer for MUD output with sequence numbering
 *
 * Stores chunks of MUD output with monotonically increasing sequence numbers.
 * When buffer reaches capacity, oldest chunks are dropped (wrap-around).
 */

import type { BufferChunk } from './types';

export class CircularBuffer {
  private chunks: BufferChunk[] = [];
  private currentSize = 0;
  private readonly maxSize: number;
  private sequenceCounter = 0;

  constructor(maxSizeBytes: number) {
    this.maxSize = maxSizeBytes;
  }

  /**
   * Add data to the buffer with a new sequence number
   * Drops oldest chunks if necessary to stay within size limit
   */
  append(
    data: Buffer,
    type: 'data' | 'gmcp',
    metadata?: Partial<BufferChunk>,
  ): BufferChunk {
    const chunk: BufferChunk = {
      sequence: ++this.sequenceCounter,
      timestamp: Date.now(),
      data,
      type,
      ...metadata,
    };

    const chunkSize = data.length + 256; // Overhead estimate

    // Remove oldest chunks until we have room
    while (
      this.currentSize + chunkSize > this.maxSize &&
      this.chunks.length > 0
    ) {
      const oldest = this.chunks.shift();
      if (oldest) {
        this.currentSize -= oldest.data.length + 256;
      }
    }

    this.chunks.push(chunk);
    this.currentSize += chunkSize;

    return chunk;
  }

  /**
   * Get all chunks from a specific sequence number onward
   * Returns empty array if sequence not found (may have been evicted)
   */
  replayFrom(sequence: number): BufferChunk[] {
    const index = this.chunks.findIndex((chunk) => chunk.sequence >= sequence);
    if (index === -1) {
      return [];
    }
    return this.chunks.slice(index);
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
    if (this.chunks.length === 0) {
      return 0;
    }
    return this.chunks[this.chunks.length - 1].sequence;
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
    return this.chunks.length;
  }

  /**
   * Check if a sequence number is still in the buffer
   */
  hasSequence(sequence: number): boolean {
    if (this.chunks.length === 0) {
      return false;
    }
    return (
      sequence >= this.chunks[0].sequence &&
      sequence <= this.chunks[this.chunks.length - 1].sequence
    );
  }

  /**
   * Clear all data from buffer
   */
  clear(): void {
    this.chunks = [];
    this.currentSize = 0;
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
    return {
      chunks: this.chunks.length,
      sizeBytes: this.currentSize,
      maxSizeBytes: this.maxSize,
      currentSequence: this.sequenceCounter,
      oldestSequence: this.chunks.length > 0 ? this.chunks[0].sequence : 0,
      newestSequence: this.getLastSequence(),
    };
  }
}
