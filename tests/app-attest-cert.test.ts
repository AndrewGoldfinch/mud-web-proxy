import { describe, test, expect } from 'bun:test';
import {
  extractNonceFromCert,
  buildAppleNonceDer,
} from '../src/app-attest';

describe('extractNonceFromCert', () => {
  test('extracts 32-byte nonce from DER cert extension', () => {
    const nonce = Buffer.alloc(32, 0x42);
    const extensionDer = buildAppleNonceDer(nonce);
    const extracted = extractNonceFromCert(extensionDer);
    expect(extracted).toEqual(nonce);
  });

  test('throws if OID not found', () => {
    expect(() => extractNonceFromCert(Buffer.from([0x00, 0x01]))).toThrow(
      'Apple nonce OID not found',
    );
  });
});
