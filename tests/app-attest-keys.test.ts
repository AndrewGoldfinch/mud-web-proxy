import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadAttestedKeys,
  saveAttestedKeys,
  getAttestedKey,
  setAttestedKey,
  updateSignCount,
  _resetKeysForTesting,
} from '../src/app-attest';

describe('attested keys store', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `attest-test-${Date.now()}.json`);
    _resetKeysForTesting();
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test('getAttestedKey returns undefined for unknown keyId', () => {
    expect(getAttestedKey('unknown')).toBeUndefined();
  });

  test('setAttestedKey and getAttestedKey round-trips', () => {
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 0,
      registeredAt: new Date().toISOString(),
    });
    const entry = getAttestedKey('key1');
    expect(entry?.publicKey).toBe('---PEM---');
    expect(entry?.signCount).toBe(0);
  });

  test('updateSignCount updates signCount', () => {
    setAttestedKey('key2', {
      publicKey: '---PEM---',
      signCount: 5,
      registeredAt: new Date().toISOString(),
    });
    updateSignCount('key2', 10);
    expect(getAttestedKey('key2')?.signCount).toBe(10);
  });

  test('saveAttestedKeys writes JSON file and loadAttestedKeys reads it back', () => {
    setAttestedKey('key3', {
      publicKey: '---PEM---',
      signCount: 3,
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    saveAttestedKeys(tmpFile);
    _resetKeysForTesting();
    loadAttestedKeys(tmpFile);
    expect(getAttestedKey('key3')?.signCount).toBe(3);
  });

  test('loadAttestedKeys is a no-op if file does not exist', () => {
    expect(() => loadAttestedKeys('/nonexistent/path.json')).not.toThrow();
  });
});
