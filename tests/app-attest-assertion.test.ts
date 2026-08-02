import { describe, test, expect } from 'bun:test';
import { createHash, generateKeyPairSync, createSign } from 'crypto';
import type { KeyObject } from 'crypto';
import { encode } from 'cbor-x';
import { verifyAssertion } from '../src/app-attest';

const BUNDLE_ID = 'com.example.testapp';

function makeAuthData(bundleId: string, signCount: number): Buffer {
  const rpIdHash = createHash('sha256').update(bundleId).digest();
  const buf = Buffer.alloc(37);
  rpIdHash.copy(buf, 0);
  buf[32] = 0x01; // flags
  buf.writeUInt32BE(signCount, 33);
  return buf;
}

function makeAssertion(
  privateKey: KeyObject,
  nonce: string,
  bundleId: string,
  signCount: number,
): Buffer {
  const authenticatorData = makeAuthData(bundleId, signCount);
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(nonce, 'hex'))
    .digest();
  const signer = createSign('SHA256');
  signer.update(authenticatorData);
  signer.update(clientDataHash);
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'der' });
  return Buffer.from(encode({ signature, authenticatorData }));
}

/**
 * Apple signs the assertion nonce, not the concatenation directly:
 * nonce = SHA256(authenticatorData || clientDataHash), then
 * ECDSA-SHA256 over that nonce. That is a double hash, and it is the one
 * shape the verifier could only reach through its null-digest branch —
 * which OpenSSL silently treated as SHA-256 and BoringSSL rejects outright.
 */
function makeAppleStyleAssertion(
  privateKey: KeyObject,
  nonce: string,
  bundleId: string,
  signCount: number,
): Buffer {
  const authenticatorData = makeAuthData(bundleId, signCount);
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(nonce, 'hex'))
    .digest();
  const assertionNonce = createHash('sha256')
    .update(Buffer.concat([authenticatorData, clientDataHash]))
    .digest();
  const signer = createSign('SHA256');
  signer.update(assertionNonce);
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'der' });
  return Buffer.from(encode({ signature, authenticatorData }));
}

describe('verifyAssertion', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const publicKeyPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();

  test('verifies a valid assertion', async () => {
    const nonce = 'a'.repeat(64); // 32 hex bytes
    const assertionBuffer = makeAssertion(privateKey, nonce, BUNDLE_ID, 1);
    const result = await verifyAssertion({
      assertionBuffer,
      nonce,
      bundleId: BUNDLE_ID,
      storedPublicKey: publicKeyPem,
      storedSignCount: 0,
    });
    expect(result.newSignCount).toBe(1);
  });

  test('verifies an Apple-style assertion signed over the nonce', async () => {
    const nonce = 'e'.repeat(64);
    const assertionBuffer = makeAppleStyleAssertion(
      privateKey,
      nonce,
      BUNDLE_ID,
      1,
    );
    const result = await verifyAssertion({
      assertionBuffer,
      nonce,
      bundleId: BUNDLE_ID,
      storedPublicKey: publicKeyPem,
      storedSignCount: 0,
    });
    expect(result.newSignCount).toBe(1);
  });

  test('rejects an Apple-style assertion with a tampered nonce', async () => {
    const nonce = 'f'.repeat(64);
    const assertionBuffer = makeAppleStyleAssertion(
      privateKey,
      nonce,
      BUNDLE_ID,
      1,
    );
    await expect(
      verifyAssertion({
        assertionBuffer,
        nonce: '0'.repeat(64), // different nonce → signature must not verify
        bundleId: BUNDLE_ID,
        storedPublicKey: publicKeyPem,
        storedSignCount: 0,
      }),
    ).rejects.toThrow();
  });

  test('names the variant that actually verified', async () => {
    // Without this, "which code path does production depend on?" is
    // unanswerable from logs — which is how a runtime incompatibility in that
    // path reached production in rc.8 while every rehearsal passed.
    const nonce = '1'.repeat(64);
    const result = await verifyAssertion({
      assertionBuffer: makeAppleStyleAssertion(
        privateKey,
        nonce,
        BUNDLE_ID,
        1,
      ),
      nonce,
      bundleId: BUNDLE_ID,
      storedPublicKey: publicKeyPem,
      storedSignCount: 0,
    });
    expect(result.matchedVariant).toBeTruthy();
    // key candidate : client-hash candidate : payload variant : encoding
    expect(result.matchedVariant.split(':').length).toBeGreaterThanOrEqual(4);
    expect(result.matchedVariant).toContain('der');
  });

  test('summarises failures instead of enumerating every attempt', async () => {
    const nonce = '2'.repeat(64);
    const assertionBuffer = makeAssertion(privateKey, nonce, BUNDLE_ID, 1);
    const tampered = Buffer.from(assertionBuffer);
    tampered[tampered.length - 1] ^= 0xff;

    let caught: Error | undefined;
    try {
      await verifyAssertion({
        assertionBuffer: tampered,
        nonce,
        bundleId: BUNDLE_ID,
        storedPublicKey: publicKeyPem,
        storedSignCount: 0,
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const message = caught!.message;
    // A count and error classes, not the matrix itself. One production
    // failure line repeated the same error 120 times across several KB.
    expect(message).toMatch(/attempts=\d+/);
    expect(message).toMatch(/errors=[^,]+ x\d+/);
    expect(message).not.toContain('|');
    expect(message.length).toBeLessThan(600);
    // The full matrix is still available to callers, for debug-level logging.
    const details = (caught as { attemptDetails?: string[] }).attemptDetails;
    expect(Array.isArray(details)).toBe(true);
    expect(details!.length).toBeGreaterThan(10);
  });

  test('rejects replayed signCount', async () => {
    const nonce = 'b'.repeat(64);
    const assertionBuffer = makeAssertion(privateKey, nonce, BUNDLE_ID, 0);
    await expect(
      verifyAssertion({
        assertionBuffer,
        nonce,
        bundleId: BUNDLE_ID,
        storedPublicKey: publicKeyPem,
        storedSignCount: 5, // stored > incoming → replay
      }),
    ).rejects.toThrow('signCount must be greater than stored');
  });

  test('rejects wrong rpIdHash', async () => {
    const nonce = 'c'.repeat(64);
    const assertionBuffer = makeAssertion(
      privateKey,
      nonce,
      'com.attacker.app',
      1,
    );
    await expect(
      verifyAssertion({
        assertionBuffer,
        nonce,
        bundleId: BUNDLE_ID,
        storedPublicKey: publicKeyPem,
        storedSignCount: 0,
      }),
    ).rejects.toThrow('rpIdHash');
  });

  test('rejects tampered signature', async () => {
    const nonce = 'd'.repeat(64);
    const assertionBuffer = makeAssertion(privateKey, nonce, BUNDLE_ID, 1);
    const tampered = Buffer.from(assertionBuffer);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(
      verifyAssertion({
        assertionBuffer: tampered,
        nonce,
        bundleId: BUNDLE_ID,
        storedPublicKey: publicKeyPem,
        storedSignCount: 0,
      }),
    ).rejects.toThrow();
  });
});
