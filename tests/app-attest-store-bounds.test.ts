/**
 * The App Attest nonce and key stores are bounded, and the key file is
 * written atomically (MWP-95).
 *
 * Both maps used to grow without limit. `/attest/challenge` is
 * unauthenticated, so the nonce store was the one piece of server state an
 * anonymous caller could inflate directly; the key store grew with every
 * device that ever registered and never shrank. And `saveAttestedKeys`
 * truncated the live file before writing it, so an interrupted write left
 * JSON that `loadAttestedKeys` treats as "start fresh" — silently
 * deregistering every device.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateChallenge,
  validateAndConsumeNonce,
  challengeCount,
  attestedKeyCount,
  setAttestedKey,
  getAttestedKey,
  updateSignCount,
  loadAttestedKeys,
  saveAttestedKeys,
  _resetNoncesForTesting,
  _resetKeysForTesting,
} from '../src/app-attest';

const MAX_CHALLENGES = 10_000;
const MAX_ATTESTED_KEYS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toISOString();

describe('the nonce store is bounded', () => {
  beforeEach(() => {
    _resetNoncesForTesting();
  });

  test('a challenge can be issued and consumed once', () => {
    const nonce = generateChallenge();
    expect(validateAndConsumeNonce(nonce)).toBe(true);
    expect(validateAndConsumeNonce(nonce)).toBe(false);
  });

  test('consuming a nonce releases its slot', () => {
    const nonce = generateChallenge();
    expect(challengeCount()).toBe(1);
    validateAndConsumeNonce(nonce);
    expect(challengeCount()).toBe(0);
  });

  test('the store never exceeds its ceiling under a flood', () => {
    // The per-source rate limit is the first line of defence; this is the
    // backstop for a distributed caller that stays under it.
    for (let i = 0; i < MAX_CHALLENGES + 500; i++) {
      generateChallenge();
    }
    expect(challengeCount()).toBeLessThanOrEqual(MAX_CHALLENGES);
  });

  test('a flood evicts the oldest nonces, not the newest', () => {
    // Evicting the newest would let an attacker deny service to the client
    // whose request is currently in flight.
    const first = generateChallenge();
    for (let i = 0; i < MAX_CHALLENGES; i++) {
      generateChallenge();
    }
    const last = generateChallenge();

    expect(validateAndConsumeNonce(first)).toBe(false);
    expect(validateAndConsumeNonce(last)).toBe(true);
  });

  test('issuing still succeeds when the store is saturated', () => {
    // Refusing to issue would turn a flood into a denial of registration for
    // every legitimate client.
    for (let i = 0; i < MAX_CHALLENGES + 10; i++) {
      generateChallenge();
    }
    const nonce = generateChallenge();
    expect(validateAndConsumeNonce(nonce)).toBe(true);
  });

  test('an unknown nonce is rejected', () => {
    expect(validateAndConsumeNonce('deadbeef')).toBe(false);
  });
});

describe('the attested-key store is bounded with TTL eviction', () => {
  beforeEach(() => {
    _resetKeysForTesting();
  });

  const entry = (registeredAt: string, lastUsedAt?: string) => ({
    publicKey: '---PEM---',
    signCount: 0,
    registeredAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
  });

  test('a fresh key is retained', () => {
    setAttestedKey('fresh', entry(daysAgo(1)));
    expect(getAttestedKey('fresh')).toBeDefined();
  });

  test('a key untouched past the TTL is evicted on the next write', () => {
    setAttestedKey('stale', entry(daysAgo(120)));
    // Eviction runs on write, so the stale entry goes when the next key
    // arrives rather than lingering until restart.
    setAttestedKey('fresh', entry(daysAgo(0)));
    expect(getAttestedKey('stale')).toBeUndefined();
    expect(getAttestedKey('fresh')).toBeDefined();
  });

  test('a key just inside the TTL survives', () => {
    setAttestedKey('borderline', entry(daysAgo(89)));
    setAttestedKey('trigger', entry(daysAgo(0)));
    expect(getAttestedKey('borderline')).toBeDefined();
  });

  test('recent use keeps an old registration alive', () => {
    // A device that registered a year ago but connected yesterday is active,
    // and TTL on registeredAt alone would throw it out.
    setAttestedKey('old-but-active', entry(daysAgo(300), daysAgo(1)));
    setAttestedKey('trigger', entry(daysAgo(0)));
    expect(getAttestedKey('old-but-active')).toBeDefined();
  });

  test('a successful assertion refreshes the activity stamp', () => {
    setAttestedKey('key', entry(daysAgo(80)));
    updateSignCount('key', 7);

    const stored = getAttestedKey('key');
    expect(stored?.signCount).toBe(7);
    expect(stored?.lastUsedAt).toBeDefined();
    expect(Date.now() - Date.parse(stored!.lastUsedAt!)).toBeLessThan(5_000);
  });

  test('updateSignCount on an unknown key is a no-op', () => {
    expect(() => updateSignCount('nope', 1)).not.toThrow();
    expect(attestedKeyCount()).toBe(0);
  });

  test('replacing an existing key does not grow the store', () => {
    setAttestedKey('key', entry(daysAgo(1)));
    setAttestedKey('key', entry(daysAgo(0)));
    expect(attestedKeyCount()).toBe(1);
  });

  test('an entry with an unparseable timestamp is kept, not discarded', () => {
    // A malformed file should not silently deregister a working device;
    // treating a bad date as "epoch" would evict it immediately.
    setAttestedKey('weird', entry('not-a-date'));
    setAttestedKey('trigger', entry(daysAgo(0)));
    expect(getAttestedKey('weird')).toBeDefined();
  });
});

describe('the key store survives an interrupted write', () => {
  let tmpDir: string;
  let keysFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-atomic-'));
    keysFile = path.join(tmpDir, 'attested-keys.json');
    _resetKeysForTesting();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a completed write round-trips', () => {
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 4,
      registeredAt: new Date().toISOString(),
    });
    saveAttestedKeys(keysFile);
    _resetKeysForTesting();
    loadAttestedKeys(keysFile);

    expect(getAttestedKey('key1')?.signCount).toBe(4);
  });

  test('the live file is never left truncated mid-write', () => {
    // The write is staged in a private directory and renamed into place, so
    // at no point does the destination contain a partial document.
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 1,
      registeredAt: new Date().toISOString(),
    });
    saveAttestedKeys(keysFile);
    const original = fs.readFileSync(keysFile, 'utf-8');

    // Simulate the crash: a staging directory holds a partial document, but
    // the rename never happened.
    const orphan = path.join(tmpDir, '.attested-keys-abc123');
    fs.mkdirSync(orphan, { mode: 0o700 });
    fs.writeFileSync(path.join(orphan, 'keys.json'), '{"key2": {"publi');

    expect(fs.readFileSync(keysFile, 'utf-8')).toBe(original);
    _resetKeysForTesting();
    loadAttestedKeys(keysFile);
    expect(getAttestedKey('key1')?.signCount).toBe(1);

    fs.rmSync(orphan, { recursive: true, force: true });
  });

  // Permission bits do not restrain root, so this one asserts nothing when
  // the suite runs in a root container. Skipping is honest; passing
  // vacuously is not.
  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)('a failed write leaves the previous file intact', () => {
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 1,
      registeredAt: new Date().toISOString(),
    });
    saveAttestedKeys(keysFile);
    const original = fs.readFileSync(keysFile, 'utf-8');

    // A directory that cannot be written to: the save must throw rather than
    // destroy what is already on disk.
    const readOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-ro-'));
    const blocked = path.join(readOnlyDir, 'sub', 'keys.json');
    fs.mkdirSync(path.dirname(blocked));
    fs.chmodSync(path.dirname(blocked), 0o500);

    setAttestedKey('key2', {
      publicKey: '---PEM2---',
      signCount: 2,
      registeredAt: new Date().toISOString(),
    });
    expect(() => saveAttestedKeys(blocked)).toThrow();

    // The unrelated good file is untouched, and no temp litter remains.
    expect(fs.readFileSync(keysFile, 'utf-8')).toBe(original);
    fs.chmodSync(path.dirname(blocked), 0o700);
    expect(fs.readdirSync(path.dirname(blocked))).toHaveLength(0);
    fs.rmSync(readOnlyDir, { recursive: true, force: true });
  });

  test('staging happens in a private directory, not a guessable path', () => {
    // The write is staged inside a mkdtemp directory (mode 0700, random
    // name), so the symlink race this used to defend against with O_EXCL
    // alone is structurally unreachable: nothing else can pre-create or even
    // list the file before the rename. Asserted on the directory rather than
    // by patching fs, so the test observes behaviour instead of internals.
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 1,
      registeredAt: new Date().toISOString(),
    });

    const seen = new Set<string>();
    const realRename = fs.renameSync;
    try {
      // Stop each save just before the rename so the staging directory can be
      // inspected while it still exists.
      (fs as { renameSync: unknown }).renameSync = (from: string) => {
        seen.add(from);
        const mode = fs.statSync(path.dirname(from)).mode & 0o777;
        expect(mode).toBe(0o700);
        throw new Error('stop before rename');
      };
      for (let i = 0; i < 5; i++) {
        try {
          saveAttestedKeys(keysFile);
        } catch {
          // expected
        }
      }
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }

    // A fresh staging directory per save, and none named from the pid.
    expect(seen.size).toBe(5);
    for (const name of seen) {
      expect(name).not.toContain(String(process.pid));
    }
  });

  test('an interrupted save leaves no staging directory behind', () => {
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 1,
      registeredAt: new Date().toISOString(),
    });

    const realRename = fs.renameSync;
    try {
      (fs as { renameSync: unknown }).renameSync = () => {
        throw new Error('simulated crash before rename');
      };
      expect(() => saveAttestedKeys(keysFile)).toThrow();
    } finally {
      (fs as { renameSync: unknown }).renameSync = realRename;
    }

    // Cleanup runs in a finally, so a failed save is not a slow leak of
    // staging directories on every debounced write.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test('a save leaves no temp files behind', () => {
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 1,
      registeredAt: new Date().toISOString(),
    });
    saveAttestedKeys(keysFile);

    expect(fs.readdirSync(tmpDir)).toEqual(['attested-keys.json']);
  });

  test('loading a corrupt file starts fresh rather than throwing', () => {
    fs.writeFileSync(keysFile, '{ this is not json', 'utf-8');
    expect(() => loadAttestedKeys(keysFile)).not.toThrow();
    expect(attestedKeyCount()).toBe(0);
  });
});

describe('loading applies the same bounds as writing', () => {
  let tmpDir: string;
  let keysFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-load-'));
    keysFile = path.join(tmpDir, 'attested-keys.json');
    _resetKeysForTesting();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('stale entries in the file are not resurrected', () => {
    // A file written before a long outage would otherwise reintroduce keys a
    // running process would have reclaimed.
    //
    // Both entries carry `lastUsedAt`, i.e. they were written by a version
    // that tracks activity. Entries *without* it are a different case — they
    // predate the TTL and are grandfathered rather than aged out, because
    // their registration date says nothing about whether the device is still
    // in use. That is covered above.
    fs.writeFileSync(
      keysFile,
      JSON.stringify({
        stale: {
          publicKey: '---PEM---',
          signCount: 0,
          registeredAt: daysAgo(300),
          lastUsedAt: daysAgo(200),
        },
        fresh: {
          publicKey: '---PEM---',
          signCount: 0,
          registeredAt: daysAgo(300),
          lastUsedAt: daysAgo(2),
        },
      }),
      'utf-8',
    );

    loadAttestedKeys(keysFile);

    expect(getAttestedKey('stale')).toBeUndefined();
    expect(getAttestedKey('fresh')).toBeDefined();
  });

  test('an oversized file is truncated to the ceiling on load', () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ATTESTED_KEYS + 50; i++) {
      entries[`key${i}`] = {
        publicKey: '---PEM---',
        signCount: 0,
        registeredAt: daysAgo(1),
      };
    }
    fs.writeFileSync(keysFile, JSON.stringify(entries), 'utf-8');

    loadAttestedKeys(keysFile);

    expect(attestedKeyCount()).toBeLessThanOrEqual(MAX_ATTESTED_KEYS);
  });

  test('an upgrade does not deregister an established fleet', () => {
    // Regression: files written before the TTL existed have no `lastUsedAt`,
    // and inferring inactivity from `registeredAt` evicted every device that
    // registered more than 90 days ago — however recently it had connected.
    // Clients cache their keyId in the Keychain and skip registration, so
    // they do not recover on their own; they just start failing.
    fs.writeFileSync(
      keysFile,
      JSON.stringify({
        legacyActive: {
          publicKey: '---PEM---',
          signCount: 900,
          registeredAt: daysAgo(200),
        },
      }),
      'utf-8',
    );

    loadAttestedKeys(keysFile);

    expect(getAttestedKey('legacyActive')).toBeDefined();
    expect(getAttestedKey('legacyActive')?.signCount).toBe(900);
  });

  test('grandfathered entries start their TTL clock at load', () => {
    const originalRegisteredAt = daysAgo(400);
    fs.writeFileSync(
      keysFile,
      JSON.stringify({
        legacy: {
          publicKey: '---PEM---',
          signCount: 1,
          registeredAt: originalRegisteredAt,
        },
      }),
      'utf-8',
    );

    loadAttestedKeys(keysFile);

    const stamped = getAttestedKey('legacy');
    expect(stamped?.lastUsedAt).toBeDefined();
    expect(Date.now() - Date.parse(stamped!.lastUsedAt!)).toBeLessThan(5_000);
    // registeredAt is history and must not be rewritten.
    expect(stamped?.registeredAt).toBe(originalRegisteredAt);
  });

  test('the grandfathered stamp survives a save/load round trip', () => {
    // After one cycle every entry carries lastUsedAt, so the migration is
    // self-healing and does not re-run on every restart.
    fs.writeFileSync(
      keysFile,
      JSON.stringify({
        legacy: {
          publicKey: '---PEM---',
          signCount: 1,
          registeredAt: daysAgo(200),
        },
      }),
      'utf-8',
    );

    loadAttestedKeys(keysFile);
    saveAttestedKeys(keysFile);

    const onDisk = JSON.parse(fs.readFileSync(keysFile, 'utf-8')) as Record<
      string,
      { lastUsedAt?: string }
    >;
    expect(onDisk.legacy.lastUsedAt).toBeDefined();
  });

  test('an entry already carrying lastUsedAt is still aged out', () => {
    // Grandfathering must not become a blanket amnesty: once a key has a real
    // activity stamp, the TTL applies to it normally.
    fs.writeFileSync(
      keysFile,
      JSON.stringify({
        genuinelyStale: {
          publicKey: '---PEM---',
          signCount: 1,
          registeredAt: daysAgo(300),
          lastUsedAt: daysAgo(200),
        },
      }),
      'utf-8',
    );

    loadAttestedKeys(keysFile);

    expect(getAttestedKey('genuinelyStale')).toBeUndefined();
  });

  test('the most recently active entries are the ones kept', () => {
    const entries: Record<string, unknown> = {
      ancient: {
        publicKey: '---PEM---',
        signCount: 0,
        registeredAt: daysAgo(80),
      },
      yesterday: {
        publicKey: '---PEM---',
        signCount: 0,
        registeredAt: daysAgo(1),
      },
    };
    fs.writeFileSync(keysFile, JSON.stringify(entries), 'utf-8');

    loadAttestedKeys(keysFile);

    expect(getAttestedKey('yesterday')).toBeDefined();
    expect(getAttestedKey('ancient')).toBeDefined();
  });
});
