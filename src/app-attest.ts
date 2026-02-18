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

export function parseAttestationAuthData(authData: Buffer): AttestationAuthData {
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
