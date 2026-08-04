import { describe, it, expect } from 'bun:test';
import { CircularBuffer } from '../src/circular-buffer';

describe('CircularBuffer', () => {
  describe('basic operations', () => {
    it('should create buffer with specified size', () => {
      const buffer = new CircularBuffer(1024);
      expect(buffer.getSize()).toBe(0);
      expect(buffer.getCurrentSequence()).toBe(0);
    });

    it('should append data and increment sequence', () => {
      const buffer = new CircularBuffer(1024);
      const chunk = buffer.append(Buffer.from('test'), 'data');

      expect(chunk.sequence).toBe(1);
      expect(chunk.type).toBe('data');
      expect(buffer.getCurrentSequence()).toBe(1);
      expect(buffer.getChunkCount()).toBe(1);
    });

    it('should handle multiple appends', () => {
      const buffer = new CircularBuffer(10240); // Larger buffer

      for (let i = 0; i < 5; i++) {
        buffer.append(Buffer.from('t' + i), 'data');
      }

      expect(buffer.getCurrentSequence()).toBe(5);
      expect(buffer.getChunkCount()).toBe(5);
    });
  });

  describe('sequence numbering', () => {
    it('should generate monotonically increasing sequences', () => {
      const buffer = new CircularBuffer(1024);
      const sequences: number[] = [];

      for (let i = 0; i < 10; i++) {
        const chunk = buffer.append(Buffer.from('t'), 'data');
        sequences.push(chunk.sequence);
      }

      for (let i = 1; i < sequences.length; i++) {
        expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
      }
    });

    it('should get last sequence', () => {
      const buffer = new CircularBuffer(1024);
      buffer.append(Buffer.from('test1'), 'data');
      buffer.append(Buffer.from('test2'), 'data');
      buffer.append(Buffer.from('test3'), 'data');

      expect(buffer.getLastSequence()).toBe(3);
    });

    it('should return 0 for empty buffer last sequence', () => {
      const buffer = new CircularBuffer(1024);
      expect(buffer.getLastSequence()).toBe(0);
    });
  });

  describe('replay functionality', () => {
    // The argument is what the client already has, so it must not come back.
    // This previously asserted the inclusive contract — replayAfter(2)
    // returning chunks 2 and 3 — which is what made every resume re-deliver
    // the client's last frame and render the MUD's final line twice.
    it('should replay strictly after the acknowledged sequence', () => {
      const buffer = new CircularBuffer(1024);

      buffer.append(Buffer.from('chunk1'), 'data');
      buffer.append(Buffer.from('chunk2'), 'data');
      buffer.append(Buffer.from('chunk3'), 'data');

      const replay = buffer.replayAfter(2);
      expect(replay.map((c) => c.sequence)).toEqual([3]);
    });

    it('should return nothing when the client is already current', () => {
      const buffer = new CircularBuffer(1024);
      buffer.append(Buffer.from('chunk1'), 'data');
      buffer.append(Buffer.from('chunk2'), 'data');

      expect(buffer.replayAfter(2)).toEqual([]);
    });

    it('should replay everything for a client that has seen nothing', () => {
      const buffer = new CircularBuffer(1024);
      buffer.append(Buffer.from('chunk1'), 'data');
      buffer.append(Buffer.from('chunk2'), 'data');

      expect(buffer.replayAfter(0).map((c) => c.sequence)).toEqual([1, 2]);
    });

    it('should skip evicted sequences and resume at the first newer chunk', () => {
      // Forces eviction so the sequenceIndex lookup misses and the scan path
      // runs — the branch that also had to change to a strict comparison.
      const buffer = new CircularBuffer(600);
      for (let i = 0; i < 6; i++) {
        buffer.append(Buffer.alloc(100), 'data');
      }
      const remaining = buffer.replayAfter(0).map((c) => c.sequence);
      const evicted = remaining[0] - 1;

      // Asking from an evicted sequence yields the surviving chunks, and the
      // oldest survivor is strictly newer than what was asked for.
      const replay = buffer.replayAfter(evicted).map((c) => c.sequence);
      expect(replay).toEqual(remaining);
      expect(replay[0]).toBeGreaterThan(evicted);
    });

    it('should return empty array for sequence not in buffer', () => {
      const buffer = new CircularBuffer(1024);
      buffer.append(Buffer.from('test'), 'data');

      const replay = buffer.replayAfter(100);
      expect(replay.length).toBe(0);
    });
  });

  describe('clear operation', () => {
    it('should clear all data', () => {
      const buffer = new CircularBuffer(1024);
      buffer.append(Buffer.from('test1'), 'data');
      buffer.append(Buffer.from('test2'), 'data');

      buffer.clear();

      expect(buffer.getSize()).toBe(0);
      expect(buffer.getChunkCount()).toBe(0);
      expect(buffer.getCurrentSequence()).toBe(2);
    });
  });
});
