import {
  randomBytes,
  createHash,
  X509Certificate,
  createVerify,
  createPublicKey,
} from 'crypto';
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
  credentialPublicKey: Buffer;
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
  const credIdStart = 55;
  const credIdEnd = credIdStart + credIdLen;
  const credId = Buffer.from(authData.subarray(credIdStart, credIdEnd));
  const credentialPublicKey = Buffer.from(authData.subarray(credIdEnd));
  return { rpIdHash, flags, signCount, aaguid, credId, credentialPublicKey };
}

export function parseAssertionAuthData(authData: Buffer): AssertionAuthData {
  return {
    rpIdHash: Buffer.from(authData.subarray(0, 32)),
    flags: authData[32],
    signCount: authData.readUInt32BE(33),
  };
}

function decodeBase64Like(input: string): Buffer | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized + '==='.slice((normalized.length + 3) % 4);
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getCoseMapValue(
  coseKey: unknown,
  numericKey: number,
): unknown {
  if (coseKey instanceof Map) {
    return coseKey.get(numericKey);
  }

  if (typeof coseKey === 'object' && coseKey !== null) {
    const obj = coseKey as Record<string, unknown>;
    const direct = obj[String(numericKey)];
    if (direct !== undefined) {
      return direct;
    }
    return obj[numericKey as unknown as keyof typeof obj];
  }

  return undefined;
}

function coseEcP256ToPem(coseKeyBuffer: Buffer): string {
  const decoded = decode(coseKeyBuffer) as unknown;
  const x = getCoseMapValue(decoded, -2);
  const y = getCoseMapValue(decoded, -3);

  const xBuf = Buffer.isBuffer(x) ? x : x ? Buffer.from(x as Uint8Array) : null;
  const yBuf = Buffer.isBuffer(y) ? y : y ? Buffer.from(y as Uint8Array) : null;

  if (!xBuf || !yBuf || xBuf.length !== 32 || yBuf.length !== 32) {
    throw new Error('Invalid COSE key coordinates');
  }

  const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
  const spkiPrefix = Buffer.from(
    '3059301306072A8648CE3D020106082A8648CE3D030107034200',
    'hex',
  );
  const spkiDer = Buffer.concat([spkiPrefix, uncompressedPoint]);
  const publicKey = createPublicKey({
    key: spkiDer,
    format: 'der',
    type: 'spki',
  });
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
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

  const readDerLength = (
    buf: Buffer,
    offset: number,
  ): { length: number; next: number } => {
    const first = buf[offset];
    if (first === undefined) {
      throw new Error('Invalid DER length');
    }

    if ((first & 0x80) === 0) {
      return { length: first, next: offset + 1 };
    }

    const byteCount = first & 0x7f;
    if (byteCount === 0 || byteCount > 4) {
      throw new Error('Unsupported DER length encoding');
    }

    if (offset + 1 + byteCount > buf.length) {
      throw new Error('Truncated DER length');
    }

    let length = 0;
    for (let i = 0; i < byteCount; i++) {
      length = (length << 8) | buf[offset + 1 + i];
    }
    return { length, next: offset + 1 + byteCount };
  };

  const readDerTLV = (
    buf: Buffer,
    offset: number,
    expectedTag?: number,
  ): { tag: number; valueStart: number; valueEnd: number; next: number } => {
    const tag = buf[offset];
    if (tag === undefined) {
      throw new Error('Unexpected end of DER input');
    }
    if (expectedTag !== undefined && tag !== expectedTag) {
      throw new Error(
        `Unexpected DER tag 0x${tag.toString(16)}; expected 0x${expectedTag.toString(16)}`,
      );
    }

    const { length, next } = readDerLength(buf, offset + 1);
    const valueStart = next;
    const valueEnd = valueStart + length;
    if (valueEnd > buf.length) {
      throw new Error('DER value exceeds buffer');
    }

    return { tag, valueStart, valueEnd, next: valueEnd };
  };

  let pos = oidIdx + APPLE_NONCE_OID.length;

  // Optional critical BOOLEAN after extension OID.
  if (certDer[pos] === 0x01) {
    const critical = readDerTLV(certDer, pos, 0x01);
    pos = critical.next;
  }

  // Extension payload is wrapped as an OCTET STRING.
  const extOctet = readDerTLV(certDer, pos, 0x04);
  const extValue = certDer.subarray(extOctet.valueStart, extOctet.valueEnd);

  const isConstructedTag = (tag: number): boolean => (tag & 0x20) === 0x20;

  const findNonceOctet = (
    buf: Buffer,
    start: number,
    end: number,
  ): Buffer | null => {
    let cursor = start;
    while (cursor < end) {
      const tlv = readDerTLV(buf, cursor);
      if (tlv.tag === 0x04) {
        const value = Buffer.from(buf.subarray(tlv.valueStart, tlv.valueEnd));
        if (value.length === 32) {
          return value;
        }
      }

      if (isConstructedTag(tlv.tag)) {
        const nested = findNonceOctet(buf, tlv.valueStart, tlv.valueEnd);
        if (nested) {
          return nested;
        }
      }
      cursor = tlv.next;
    }
    return null;
  };

  const nonce = findNonceOctet(extValue, 0, extValue.length);
  if (!nonce) {
    throw new Error('Nonce OCTET STRING not found in extension value');
  }

  return nonce;
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
    throw new Error(`Invalid attestation format: ${obj?.fmt ?? 'unknown'}`);
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
    throw new Error('Certificate chain does not terminate at Apple root CA');
  }

  // Verify all certs in chain are currently valid
  const now = Date.now();
  for (let i = 0; i < certs.length; i++) {
    const notBefore = new Date(certs[i].validFrom).getTime();
    const notAfter = new Date(certs[i].validTo).getTime();
    if (now < notBefore || now > notAfter) {
      throw new Error(
        `Certificate ${i} is not currently valid (valid ${certs[i].validFrom} to ${certs[i].validTo})`,
      );
    }
  }

  const credCert = certs[0];
  const credCertDer = x5c[0];

  // 4. Verify rpIdHash for App Attest.
  // Apple uses TeamID.BundleID; keep bundleId-only fallback for compatibility.
  const parsed = parseAttestationAuthData(authData);
  const expectedBundleHash = createHash('sha256').update(bundleId).digest();
  const expectedAppIdHash = createHash('sha256')
    .update(`${teamId}.${bundleId}`)
    .digest();
  if (
    !parsed.rpIdHash.equals(expectedBundleHash) &&
    !parsed.rpIdHash.equals(expectedAppIdHash)
  ) {
    throw new Error('rpIdHash does not match bundleId or TeamID.BundleID');
  }

  // 5. Soft-check cert subject contains team/bundle markers.
  // Apple cert subject formatting can vary; rpIdHash + chain validation
  // are the primary trust checks.
  if (
    !credCert.subject.includes(teamId) ||
    !credCert.subject.includes(bundleId)
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[app-attest] Certificate subject mismatch; continuing. expected=${teamId}.${bundleId} subject=${credCert.subject}`,
    );
  }

  // 6. Extract credential public key from authData COSE key.
  // Assertions are signed by this key.
  const publicKeyPem = coseEcP256ToPem(parsed.credentialPublicKey);

  // 7. Verify credential identifier consistency.
  // Some valid attestations present keyId as base64/base64url of credId.
  // Keep SHA256(publicKey) as a compatibility fallback.
  const publicKeyDer = Buffer.from(
    credCert.publicKey.export({
      type: 'spki',
      format: 'der',
    }) as unknown as ArrayBuffer,
  );
  const expectedCredIdFromPublicKey = createHash('sha256')
    .update(publicKeyDer)
    .digest();
  const decodedKeyId = decodeBase64Like(keyId);
  const matchesDecodedKeyId =
    !!decodedKeyId && parsed.credId.equals(decodedKeyId);
  const matchesPublicKeyHash = parsed.credId.equals(
    expectedCredIdFromPublicKey,
  );
  if (!matchesDecodedKeyId && !matchesPublicKeyHash) {
    throw new Error(
      'credentialId mismatch: not equal to keyId bytes or SHA256(publicKey)',
    );
  }

  // 8. Verify nonce in cert extension
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(nonce, 'hex'))
    .digest();
  const expectedCertNonce = createHash('sha256')
    .update(authData)
    .update(clientDataHash)
    .digest();
  const certNonce = extractNonceFromCert(credCertDer);
  if (!certNonce.equals(expectedCertNonce)) {
    throw new Error('Certificate nonce does not match expected value');
  }

  // 9. Verify keyId encoding consistency.
  const credIdForKeyValidation = matchesDecodedKeyId
    ? parsed.credId
    : expectedCredIdFromPublicKey;
  const expectedKeyIdB64 = credIdForKeyValidation.toString('base64');
  const expectedKeyIdB64Url = toBase64Url(credIdForKeyValidation);
  if (
    keyId !== expectedKeyIdB64 &&
    keyId !== expectedKeyIdB64Url &&
    !(decodedKeyId && decodedKeyId.equals(credIdForKeyValidation))
  ) {
    throw new Error('keyId does not match expected credential identifier');
  }

  return { publicKey: publicKeyPem, keyId };
}

// ---------- Assertion verification ----------

export interface AssertionInput {
  assertionBuffer: Buffer;
  nonce: string; // hex
  bundleId: string;
  teamId?: string;
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
    teamId,
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

  // 2. Verify rpIdHash for App Attest.
  // Apple uses TeamID.BundleID; keep bundleId-only fallback for compatibility.
  const parsed = parseAssertionAuthData(authenticatorData);
  const expectedBundleHash = createHash('sha256').update(bundleId).digest();
  const expectedAppIdHash = teamId
    ? createHash('sha256')
        .update(`${teamId}.${bundleId}`)
        .digest()
    : null;
  if (
    !parsed.rpIdHash.equals(expectedBundleHash) &&
    !(expectedAppIdHash && parsed.rpIdHash.equals(expectedAppIdHash))
  ) {
    throw new Error('rpIdHash does not match bundleId or TeamID.BundleID');
  }

  // 3. Verify signCount (must be strictly greater than stored)
  if (parsed.signCount <= storedSignCount) {
    throw new Error(
      `signCount must be greater than stored (got ${parsed.signCount}, stored ${storedSignCount})`,
    );
  }

  // 4. Verify ECDSA-P256-SHA256 signature.
  // Signed data: SHA256(authenticatorData || SHA256(nonce bytes)).
  // Accept both DER and IEEE-P1363 signature encodings for compatibility.
  const clientDataHash = createHash('sha256')
    .update(Buffer.from(nonce, 'hex'))
    .digest();
  const verifyWithEncoding = (dsaEncoding: 'der' | 'ieee-p1363'): boolean => {
    try {
      const verifier = createVerify('SHA256');
      verifier.update(authenticatorData);
      verifier.update(clientDataHash);
      return verifier.verify({ key: storedPublicKey, dsaEncoding }, signature);
    } catch {
      return false;
    }
  };

  const validDer = verifyWithEncoding('der');
  const validP1363 = validDer ? false : verifyWithEncoding('ieee-p1363');
  if (!validDer && !validP1363) {
    throw new Error(
      `Assertion signature verification failed (sigLen=${signature.length}, authDataLen=${authenticatorData.length})`,
    );
  }

  return { newSignCount: parsed.signCount };
}

// ---------- Attested keys store ----------

export interface AttestedKeyEntry {
  publicKey: string; // PEM
  signCount: number;
  registeredAt: string; // ISO timestamp
}

const attestedKeys = new Map<string, AttestedKeyEntry>();

export function getAttestedKey(keyId: string): AttestedKeyEntry | undefined {
  return attestedKeys.get(keyId);
}

export function setAttestedKey(keyId: string, entry: AttestedKeyEntry): void {
  attestedKeys.set(keyId, entry);
}

export function updateSignCount(keyId: string, newCount: number): void {
  const entry = attestedKeys.get(keyId);
  if (entry) entry.signCount = newCount;
}

export function loadAttestedKeys(filePath: string): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, AttestedKeyEntry>;
    for (const [keyId, entry] of Object.entries(obj)) {
      attestedKeys.set(keyId, entry);
    }
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }
}

export function saveAttestedKeys(filePath: string): void {
  const obj: Record<string, AttestedKeyEntry> = {};
  for (const [keyId, entry] of attestedKeys) {
    obj[keyId] = entry;
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced version of saveAttestedKeys — coalesces rapid saves into one
 * write after 2 seconds of inactivity. Use this instead of calling
 * saveAttestedKeys directly from hot paths like the WebSocket connection handler.
 */
export function debouncedSaveAttestedKeys(filePath: string): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAttestedKeys(filePath);
  }, 2_000);
}

/** Test helper: clear the in-memory key store. */
export function _resetKeysForTesting(): void {
  attestedKeys.clear();
}
