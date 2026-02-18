import { randomBytes } from 'crypto';

// ---------- Nonce store ----------

const NONCE_TTL_MS = 60_000;
const challenges = new Map<string, number>(); // nonce → expiry timestamp

export function generateChallenge(): string {
  const nonce = randomBytes(32).toString('hex');
  challenges.set(nonce, Date.now() + NONCE_TTL_MS);
  // Lazy cleanup: remove expired entries
  for (const [n, exp] of challenges) {
    if (Date.now() > exp) challenges.delete(n);
  }
  return nonce;
}

export function validateAndConsumeNonce(nonce: string): boolean {
  const expiry = challenges.get(nonce);
  if (expiry === undefined) return false;
  challenges.delete(nonce); // single-use
  return Date.now() <= expiry;
}

/** Only for use in tests — clears the nonce store. */
export function _resetNoncesForTesting(): void {
  challenges.clear();
}

// ---------- authData parsing ----------

export interface AttestationAuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  aaguid: Buffer;
  credId: Buffer;
}

export interface AssertionAuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
}

export function parseAttestationAuthData(
  authData: Buffer,
): AttestationAuthData {
  const rpIdHash = Buffer.from(authData.subarray(0, 32));
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const aaguid = Buffer.from(authData.subarray(37, 53));
  const credIdLen = authData.readUInt16BE(53);
  const credId = Buffer.from(authData.subarray(55, 55 + credIdLen));
  return { rpIdHash, flags, signCount, aaguid, credId };
}

export function parseAssertionAuthData(authData: Buffer): AssertionAuthData {
  return {
    rpIdHash: Buffer.from(authData.subarray(0, 32)),
    flags: authData[32],
    signCount: authData.readUInt32BE(33),
  };
}

// ---------- Certificate nonce extraction ----------

// OID 1.2.840.113635.100.8.2 in DER encoding
const APPLE_NONCE_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
]);

/**
 * Extract the 32-byte nonce from Apple App Attest credential cert DER bytes.
 * Searches for OID 1.2.840.113635.100.8.2 in the raw DER.
 * Extension value structure: SEQUENCE { SEQUENCE { OCTET STRING <nonce> } }
 */
export function extractNonceFromCert(certDer: Buffer): Buffer {
  const oidIdx = certDer.indexOf(APPLE_NONCE_OID);
  if (oidIdx === -1)
    throw new Error('Apple nonce OID not found in certificate');

  let pos = oidIdx + APPLE_NONCE_OID.length;

  // Skip optional critical BOOLEAN (tag=0x01, length=0x01)
  if (certDer[pos] === 0x01 && certDer[pos + 1] === 0x01) pos += 3;

  // OCTET STRING wrapping the DER-encoded extension value
  if (certDer[pos] !== 0x04)
    throw new Error('Expected OCTET STRING after OID');
  pos += 1; // skip tag
  // Read length (short or long form)
  let extLen = certDer[pos++];
  if (extLen & 0x80) {
    const lenBytes = extLen & 0x7f;
    extLen = 0;
    for (let i = 0; i < lenBytes; i++) extLen = (extLen << 8) | certDer[pos++];
  }
  void extLen; // consumed for position tracking

  // Extension value: SEQUENCE { SEQUENCE { OCTET STRING <nonce> } }
  if (certDer[pos] !== 0x30)
    throw new Error('Expected outer SEQUENCE in extension value');
  pos += 2; // tag + length
  if (certDer[pos] !== 0x30)
    throw new Error('Expected inner SEQUENCE in extension value');
  pos += 2; // tag + length
  if (certDer[pos] !== 0x04)
    throw new Error('Expected OCTET STRING for nonce');
  pos += 1; // skip tag
  const nonceLen = certDer[pos++];

  return Buffer.from(certDer.subarray(pos, pos + nonceLen));
}

/**
 * Build a minimal DER buffer containing the Apple nonce OID and extension value.
 * For testing only — not a real certificate.
 */
export function buildAppleNonceDer(nonce: Buffer): Buffer {
  // OCTET STRING <nonce>: 04 <len> <bytes>
  const innerOctet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
  // SEQUENCE { innerOctet }
  const innerSeq = Buffer.concat([
    Buffer.from([0x30, innerOctet.length]),
    innerOctet,
  ]);
  // SEQUENCE { innerSeq }
  const outerSeq = Buffer.concat([
    Buffer.from([0x30, innerSeq.length]),
    innerSeq,
  ]);
  // OCTET STRING wrapping extension value
  const extValue = Buffer.concat([
    Buffer.from([0x04, outerSeq.length]),
    outerSeq,
  ]);
  return Buffer.concat([APPLE_NONCE_OID, extValue]);
}
