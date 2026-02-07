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
    it('should replay from specific sequence', () => {
      const buffer = new CircularBuffer(1024);
      
      buffer.append(Buffer.from('chunk1'), 'data');
      buffer.append(Buffer.from('chunk2'), 'data');
      buffer.append(Buffer.from('chunk3'), 'data');
      
      const replay = buffer.replayFrom(2);
      expect(replay.length).toBe(2);
      expect(replay[0].sequence).toBe(2);
      expect(replay[1].sequence).toBe(3);
    });

    it('should return empty array for sequence not in buffer', () => {
      const buffer = new CircularBuffer(1024);
      buffer.append(Buffer.from('test'), 'data');
      
      const replay = buffer.replayFrom(100);
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
