import { describe, test, expect } from 'bun:test';
import { verifyAttestation } from '../src/app-attest';
import { encode } from 'cbor-x';

describe('verifyAttestation input validation', () => {
  test('rejects non-apple-appattest fmt', async () => {
    const attestation = encode({
      fmt: 'packed',
      attStmt: {},
      authData: Buffer.alloc(100),
    });
    await expect(
      verifyAttestation({
        keyId: 'testkey',
        attestationBuffer: Buffer.from(attestation),
        nonce: 'deadbeef',
        bundleId: 'com.example.app',
        teamId: 'AAABBBCCC1',
      }),
    ).rejects.toThrow('Invalid attestation format');
  });

  test('rejects empty attestation', async () => {
    await expect(
      verifyAttestation({
        keyId: 'testkey',
        attestationBuffer: Buffer.from([]),
        nonce: 'deadbeef',
        bundleId: 'com.example.app',
        teamId: 'AAABBBCCC1',
      }),
    ).rejects.toThrow();
  });
});
