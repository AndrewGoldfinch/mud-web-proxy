import { describe, test, expect } from 'bun:test';
import { parseAttestationAuthData, parseAssertionAuthData } from '../src/app-attest';

function makeAttestationAuthData(opts: {
  rpIdHash?: Buffer;
  signCount?: number;
  credIdLen?: number;
}): Buffer {
  const rpIdHash = opts.rpIdHash ?? Buffer.alloc(32, 0xaa);
  const flags = 0x41; // attested data present
  const signCount = opts.signCount ?? 0;
  const aaguid = Buffer.alloc(16, 0x00);
  const credIdLen = opts.credIdLen ?? 32;
  const credId = Buffer.alloc(credIdLen, 0xbb);

  const buf = Buffer.alloc(55 + credIdLen);
  rpIdHash.copy(buf, 0);
  buf[32] = flags;
  buf.writeUInt32BE(signCount, 33);
  aaguid.copy(buf, 37);
  buf.writeUInt16BE(credIdLen, 53);
  credId.copy(buf, 55);
  return buf;
}

describe('parseAttestationAuthData', () => {
  test('extracts rpIdHash', () => {
    const expected = Buffer.alloc(32, 0xaa);
    const authData = makeAttestationAuthData({ rpIdHash: expected });
    const result = parseAttestationAuthData(authData);
    expect(result.rpIdHash).toEqual(expected);
  });

  test('extracts signCount (must be 0 for new attestation)', () => {
    const authData = makeAttestationAuthData({ signCount: 0 });
    const result = parseAttestationAuthData(authData);
    expect(result.signCount).toBe(0);
  });

  test('extracts credId', () => {
    const authData = makeAttestationAuthData({ credIdLen: 32 });
    const result = parseAttestationAuthData(authData);
    expect(result.credId.length).toBe(32);
  });
});

describe('parseAssertionAuthData', () => {
  test('extracts rpIdHash and signCount', () => {
    const buf = Buffer.alloc(37);
    buf.fill(0xcc, 0, 32); // rpIdHash
    buf[32] = 0x01; // flags
    buf.writeUInt32BE(5, 33); // signCount
    const result = parseAssertionAuthData(buf);
    expect(result.rpIdHash).toEqual(Buffer.alloc(32, 0xcc));
    expect(result.signCount).toBe(5);
  });
});
