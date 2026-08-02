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
  attestedKeyStoreSummary,
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
    // A current timestamp, not a fixed date: loadAttestedKeys applies the
    // 90-day TTL (MWP-95), so a hardcoded date makes this test start failing
    // once it drifts past the window.
    setAttestedKey('key3', {
      publicKey: '---PEM---',
      signCount: 3,
      registeredAt: new Date().toISOString(),
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

describe('store summary and assertion tracking', () => {
  beforeEach(() => {
    _resetKeysForTesting();
  });

  const entry = (registeredAt: string, signCount = 0) => ({
    publicKey: 'pem',
    signCount,
    registeredAt,
  });

  test('summarises counts and the registration date range', () => {
    // Dates must sit inside the 90-day TTL: the store prunes on insert, so
    // absolute dates months in the past silently vanish from the fixture.
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 86_400_000).toISOString();
    const oldest = daysAgo(30);
    const newest = daysAgo(1);

    setAttestedKey('a', entry(oldest));
    setAttestedKey('b', entry(newest, 4));
    setAttestedKey('c', entry(daysAgo(10)));

    const summary = attestedKeyStoreSummary();
    expect(summary.totalKeys).toBe(3);
    // The load-bearing figure: a total alone cannot tell a transferred store
    // from a freshly seeded one; prior assertion history can.
    expect(summary.keysWithSignCount).toBe(1);
    expect(summary.oldestRegisteredAt).toBe(oldest);
    expect(summary.newestRegisteredAt).toBe(newest);
  });

  test('lastAssertedAt is written only by a real assertion', () => {
    setAttestedKey('a', entry('2026-01-01T00:00:00.000Z'));
    expect(getAttestedKey('a')?.lastAssertedAt).toBeUndefined();
    expect(attestedKeyStoreSummary().keysAsserted).toBe(0);

    updateSignCount('a', 1);
    expect(getAttestedKey('a')?.lastAssertedAt).toBeTruthy();
    expect(attestedKeyStoreSummary().keysAsserted).toBe(1);
  });

  test('loading does not backfill lastAssertedAt the way lastUsedAt is', () => {
    // lastUsedAt is grandfathered at load for TTL safety, which is why it
    // cannot answer "has this key ever asserted?" — in production 4,974 of
    // 5,230 entries shared one load-time timestamp. lastAssertedAt must stay
    // absent so that question remains answerable.
    // mkdtempSync, not a predictable name in the shared temp dir: a
    // guessable path in /tmp can be pre-created as a symlink by another
    // local user. Same reason CodeQL flags js/insecure-temporary-file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-backfill-'));
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        legacy: {
          publicKey: 'pem',
          signCount: 3,
          registeredAt: new Date().toISOString(),
        },
      }),
    );
    try {
      _resetKeysForTesting();
      loadAttestedKeys(file);
      const loaded = getAttestedKey('legacy');
      expect(loaded).toBeDefined();
      expect(loaded?.lastUsedAt).toBeTruthy(); // backfilled, by design
      expect(loaded?.lastAssertedAt).toBeUndefined(); // never backfilled
      expect(attestedKeyStoreSummary().keysAsserted).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
