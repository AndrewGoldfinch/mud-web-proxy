import { randomBytes, createHash, X509Certificate, createVerify } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from 'cbor-x';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---------- Apple root CA ----------

const APPLE_ROOT_CA_PATH = path.resolve(
  __dirname,
  '../config/apple-app-attest-root-ca.pem',
);

function loadAppleRootCa(): Buffer | null {
  try {
    return fs.readFileSync(APPLE_ROOT_CA_PATH);
  } catch {
    return null;
  }
}

// ---------- Attestation verification ----------

export interface AttestationInput {
  keyId: string;
  attestationBuffer: Buffer;
  nonce: string; // hex — the challenge the server issued
  bundleId: string;
  teamId: string;
  rootCa?: Buffer; // override for testing
}

export interface AttestationResult {
  publicKey: string; // PEM
  keyId: string;
}

export async function verifyAttestation(
  opts: AttestationInput,
): Promise<AttestationResult> {
  const { keyId, attestationBuffer, nonce, bundleId, teamId } = opts;

  // 1. Decode CBOR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any;
  try {
    obj = decode(attestationBuffer);
  } catch {
    throw new Error('Failed to decode attestation CBOR');
  }

  // 2. Validate format
  if (!obj || obj.fmt !== 'apple-appattest') {
    throw new Error(
      `Invalid attestation format: ${obj?.fmt ?? 'unknown'}`,
    );
  }

  const x5c: Buffer[] = obj.attStmt?.x5c;
  const authData = Buffer.isBuffer(obj.authData)
    ? obj.authData
    : Buffer.from(obj.authData as Uint8Array);

  if (!x5c || x5c.length < 2) {
    throw new Error('Missing certificate chain in attestation');
  }

  // 3. Verify certificate chain against Apple root CA
  const rootCaPem = opts.rootCa ?? loadAppleRootCa();
  if (!rootCaPem) {
    throw new Error('Apple root CA not found at ' + APPLE_ROOT_CA_PATH);
  }

  const certs = x5c.map((d: Buffer) => new X509Certificate(d));
  const rootCert = new X509Certificate(rootCaPem);

  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error(`Certificate ${i} not signed by certificate ${i + 1}`);
    }
  }
  if (!certs[certs.length - 1].verify(rootCert.publicKey)) {
    throw new Error(
      'Certificate chain does not terminate at Apple root CA',
    );
  }

  const credCert = certs[0];
  const credCertDer = x5c[0];

  // 4. Verify rpIdHash == SHA256(bundleId)
  const parsed = parseAttestationAuthData(authData);
  const expectedRpIdHash = createHash('sha256').update(bundleId).digest();
  if (!parsed.rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash does not match bundleId');
  }

  // 5. Verify teamId and bundleId appear in cert subject
  if (
    !credCert.subject.includes(teamId) ||
    !credCert.subject.includes(bundleId)
  ) {
    throw new Error(
      `Certificate subject does not match teamId/bundleId (expected ${teamId}.${bundleId})`,
    );
  }

  // 6. Extract public key from credential cert
  const publicKeyPem = credCert.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();

  // 7. Verify credId == SHA256(publicKey DER)
  const publicKeyDer = Buffer.from(
    credCert.publicKey.export({ type: 'spki', format: 'der' }) as unknown as ArrayBuffer,
  );
  const expectedCredId = createHash('sha256').update(publicKeyDer).digest();
  if (!parsed.credId.equals(expectedCredId)) {
    throw new Error('credentialId does not match SHA256(publicKey)');
  }

  // 8. Verify nonce in cert extension
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(nonce, 'hex'))
    .digest();
  const expectedCertNonce = createHash('sha256')
    .update(createHash('sha256').update(authData).digest())
    .update(clientDataHash)
    .digest();
  const certNonce = extractNonceFromCert(credCertDer);
  if (!certNonce.equals(expectedCertNonce)) {
    throw new Error('Certificate nonce does not match expected value');
  }

  // 9. Verify keyId == base64(SHA256(publicKey DER))
  const expectedKeyId = createHash('sha256')
    .update(publicKeyDer)
    .digest('base64');
  if (keyId !== expectedKeyId) {
    throw new Error('keyId does not match SHA256(publicKey)');
  }

  return { publicKey: publicKeyPem, keyId };
}

// ---------- Assertion verification ----------

export interface AssertionInput {
  assertionBuffer: Buffer;
  nonce: string; // hex
  bundleId: string;
  storedPublicKey: string; // PEM
  storedSignCount: number;
}

export interface AssertionResult {
  newSignCount: number;
}

export async function verifyAssertion(
  opts: AssertionInput,
): Promise<AssertionResult> {
  const {
    assertionBuffer,
    nonce,
    bundleId,
    storedPublicKey,
    storedSignCount,
  } = opts;

  // 1. Decode CBOR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any;
  try {
    obj = decode(assertionBuffer);
  } catch {
    throw new Error('Failed to decode assertion CBOR');
  }

  const signature = Buffer.isBuffer(obj.signature)
    ? obj.signature
    : Buffer.from(obj.signature as Uint8Array);
  const authenticatorData = Buffer.isBuffer(obj.authenticatorData)
    ? obj.authenticatorData
    : Buffer.from(obj.authenticatorData as Uint8Array);

  // 2. Verify rpIdHash
  const parsed = parseAssertionAuthData(authenticatorData);
  const expectedRpIdHash = createHash('sha256').update(bundleId).digest();
  if (!parsed.rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash does not match bundleId');
  }

  // 3. Verify signCount (must be strictly greater than stored)
  if (parsed.signCount <= storedSignCount) {
    throw new Error(
      `signCount must be greater than stored (got ${parsed.signCount}, stored ${storedSignCount})`,
    );
  }

  // 4. Verify ECDSA-P256-SHA256 signature
  // Signed data: SHA256(authenticatorData || SHA256(nonce bytes))
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(nonce, 'hex'))
    .digest();
  const verifier = createVerify('SHA256');
  verifier.update(authenticatorData);
  verifier.update(clientDataHash);
  const valid = verifier.verify(
    { key: storedPublicKey, dsaEncoding: 'der' },
    signature,
  );
  if (!valid) throw new Error('Assertion signature verification failed');

  return { newSignCount: parsed.signCount };
}
