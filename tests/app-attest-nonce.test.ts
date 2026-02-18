import { describe, test, expect, beforeEach } from 'bun:test';
import {
  generateChallenge,
  validateAndConsumeNonce,
  _resetNoncesForTesting,
} from '../src/app-attest';

describe('nonce management', () => {
  beforeEach(() => {
    _resetNoncesForTesting();
  });

  test('generateChallenge returns 64-char hex string', () => {
    const nonce = generateChallenge();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  test('validateAndConsumeNonce returns true for valid nonce', () => {
    const nonce = generateChallenge();
    expect(validateAndConsumeNonce(nonce)).toBe(true);
  });

  test('validateAndConsumeNonce returns false for unknown nonce', () => {
    expect(validateAndConsumeNonce('deadbeef')).toBe(false);
  });

  test('validateAndConsumeNonce is single-use (replay protection)', () => {
    const nonce = generateChallenge();
    expect(validateAndConsumeNonce(nonce)).toBe(true);
    expect(validateAndConsumeNonce(nonce)).toBe(false);
  });

  test('each generateChallenge returns a unique nonce', () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(a).not.toBe(b);
  });
});
