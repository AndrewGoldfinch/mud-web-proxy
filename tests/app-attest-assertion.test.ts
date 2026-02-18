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
