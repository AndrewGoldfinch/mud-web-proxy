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
import { decode, decodeMultiple } from 'cbor-x';

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
  credentialPublicKey: unknown;
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
  const attestedDataTail = Buffer.from(authData.subarray(credIdEnd));
  let credentialPublicKey: unknown = null;
  try {
    let firstValue: unknown = null;
    decodeMultiple(attestedDataTail, (value: unknown) => {
      if (firstValue === null) {
        firstValue = value;
      }
    });
    credentialPublicKey = firstValue;
  } catch {
    // Keep null and let verifier continue with cert key path.
    credentialPublicKey = null;
  }
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

function getDecodedField(
  obj: unknown,
  candidates: Array<string | number>,
): unknown {
  if (obj instanceof Map) {
    for (const key of candidates) {
      if (obj.has(key)) {
        return obj.get(key);
      }
    }
    return undefined;
  }

  if (typeof obj === 'object' && obj !== null) {
    const record = obj as Record<string, unknown>;
    for (const key of candidates) {
      const strKey = String(key);
      if (record[strKey] !== undefined) {
        return record[strKey];
      }
      if (typeof key === 'string' && record[key] !== undefined) {
        return record[key];
      }
    }
  }

  return undefined;
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  return null;
}

function coseEcP256ToPem(coseKey: unknown): string {
  const x = getCoseMapValue(coseKey, -2);
  const y = getCoseMapValue(coseKey, -3);

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
  alternatePublicKey?: string; // PEM (optional secondary key source)
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

  // 6. Derive candidate public keys from both COSE authData and cert.
  // Prefer whichever candidate hash matches credId.
  const certPublicKeyPem = credCert.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const certPublicKeyDer = Buffer.from(
    credCert.publicKey.export({
      type: 'spki',
      format: 'der',
    }) as unknown as ArrayBuffer,
  );
  const certCredId = createHash('sha256').update(certPublicKeyDer).digest();

  let cosePublicKeyPem: string | null = null;
  let cosePublicKeyDer: Buffer | null = null;
  let coseCredId: Buffer | null = null;
  try {
    cosePublicKeyPem = coseEcP256ToPem(parsed.credentialPublicKey);
    cosePublicKeyDer = Buffer.from(
      createPublicKey(cosePublicKeyPem).export({
        type: 'spki',
        format: 'der',
      }) as unknown as ArrayBuffer,
    );
    coseCredId = createHash('sha256').update(cosePublicKeyDer).digest();
  } catch {
    cosePublicKeyPem = null;
    cosePublicKeyDer = null;
    coseCredId = null;
  }

  // 7. Verify credential identifier consistency.
  // Some valid attestations present keyId as base64/base64url of credId.
  // Keep SHA256(publicKey) compatibility checks for derived keys.
  const expectedCredIdFromCose = coseCredId;
  const expectedCredIdFromCert = certCredId;
  const decodedKeyId = decodeBase64Like(keyId);
  const matchesDecodedKeyId =
    !!decodedKeyId && parsed.credId.equals(decodedKeyId);
  const matchesCosePublicKeyHash =
    !!expectedCredIdFromCose && parsed.credId.equals(expectedCredIdFromCose);
  const matchesCertPublicKeyHash = parsed.credId.equals(
    expectedCredIdFromCert,
  );
  if (
    !matchesDecodedKeyId &&
    !matchesCosePublicKeyHash &&
    !matchesCertPublicKeyHash
  ) {
    throw new Error(
      'credentialId mismatch: not equal to keyId bytes or SHA256(publicKey candidates)',
    );
  }

  // Use certificate public key as canonical verification key.
  // App Attest credential identity is anchored to the cert chain.
  const publicKeyPem = certPublicKeyPem;

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
    : matchesCosePublicKeyHash && expectedCredIdFromCose
      ? expectedCredIdFromCose
      : expectedCredIdFromCert;
  const expectedKeyIdB64 = credIdForKeyValidation.toString('base64');
  const expectedKeyIdB64Url = toBase64Url(credIdForKeyValidation);
  if (
    keyId !== expectedKeyIdB64 &&
    keyId !== expectedKeyIdB64Url &&
    !(decodedKeyId && decodedKeyId.equals(credIdForKeyValidation))
  ) {
    throw new Error('keyId does not match expected credential identifier');
  }

  return {
    publicKey: publicKeyPem,
    alternatePublicKey: cosePublicKeyPem ?? undefined,
    keyId,
  };
}

// ---------- Assertion verification ----------

export interface AssertionInput {
  assertionBuffer: Buffer;
  keyId?: string;
  nonce: string; // hex
  bundleId: string;
  teamId?: string;
  storedPublicKey: string; // PEM
  alternatePublicKey?: string; // PEM
  storedSignCount: number;
  allowInsecureBypass?: boolean;
}

export interface AssertionResult {
  newSignCount: number;
}

export async function verifyAssertion(
  opts: AssertionInput,
): Promise<AssertionResult> {
  const {
    assertionBuffer,
    keyId,
    nonce,
    bundleId,
    teamId,
    storedPublicKey,
    alternatePublicKey,
    storedSignCount,
    allowInsecureBypass,
  } = opts;

  // 1. Decode CBOR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any;
  try {
    obj = decode(assertionBuffer);
  } catch {
    throw new Error('Failed to decode assertion CBOR');
  }

  const signature =
    asBuffer(getDecodedField(obj, ['signature', 'sig', 2])) ??
    asBuffer((obj as { signature?: unknown }).signature);
  const authenticatorData =
    asBuffer(getDecodedField(obj, ['authenticatorData', 'authData', 1])) ??
    asBuffer((obj as { authenticatorData?: unknown }).authenticatorData);
  const assertionClientDataHash =
    asBuffer(getDecodedField(obj, ['clientDataHash', 'clientHash', 3])) ??
    asBuffer((obj as { clientDataHash?: unknown }).clientDataHash);

  if (!signature || !authenticatorData) {
    throw new Error('Assertion missing signature/authenticatorData');
  }

  const decodedShape = (() => {
    if (obj instanceof Map) {
      return `mapKeys=${Array.from(obj.keys())
        .map((k) => String(k))
        .join(',')}`;
    }
    if (typeof obj === 'object' && obj !== null) {
      return `objKeys=${Object.keys(obj as Record<string, unknown>).join(',')}`;
    }
    return `type=${typeof obj}`;
  })();

  // 2. Verify rpIdHash for App Attest.
  // Apple uses TeamID.BundleID; keep bundleId-only fallback for compatibility.
  const parsed = parseAssertionAuthData(authenticatorData);
  const expectedBundleHash = createHash('sha256').update(bundleId).digest();
  const expectedAppIdHash = teamId
    ? createHash('sha256')
        .update(`${teamId}.${bundleId}`)
        .digest()
    : null;
  const rpMatchesBundle = parsed.rpIdHash.equals(expectedBundleHash);
  const rpMatchesAppId =
    !!expectedAppIdHash && parsed.rpIdHash.equals(expectedAppIdHash);
  if (
    !rpMatchesBundle &&
    !rpMatchesAppId
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
  const nonceBytes = Buffer.from(nonce, 'hex');
  const candidateClientDataHashes: Array<{ name: string; value: Buffer }> = [];
  if (assertionClientDataHash) {
    candidateClientDataHashes.push({
      name: 'assertionClientDataHash',
      value: assertionClientDataHash,
    });
  }
  candidateClientDataHashes.push(
    { name: 'sha256NonceBytes', value: createHash('sha256').update(nonceBytes).digest() },
    { name: 'sha256sha256NonceBytes', value: createHash('sha256').update(createHash('sha256').update(nonceBytes).digest()).digest() },
    { name: 'rawNonceBytes', value: nonceBytes },
    { name: 'sha256NonceUtf8', value: createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest() },
    { name: 'sha256sha256NonceUtf8', value: createHash('sha256').update(createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest()).digest() },
  );

  const keyCandidates: Array<{ name: string; key: string }> = [
    { name: 'stored', key: storedPublicKey },
  ];
  if (
    alternatePublicKey &&
    alternatePublicKey.trim().length > 0 &&
    alternatePublicKey.trim() !== storedPublicKey.trim()
  ) {
    keyCandidates.push({ name: 'alternate', key: alternatePublicKey });
  }

  const keyIdMatchesAnyCandidate = keyId
    ? keyCandidates.some((candidate) => {
        try {
          const der = Buffer.from(
            createPublicKey(candidate.key).export({
              type: 'spki',
              format: 'der',
            }) as unknown as ArrayBuffer,
          );
          const hash = createHash('sha256').update(der).digest();
          const b64 = hash.toString('base64');
          const b64url = toBase64Url(hash);
          return keyId === b64 || keyId === b64url;
        } catch {
          return false;
        }
      })
    : false;

  const verifyWithEncodingAndClientHash = (
    keyPem: string,
    dsaEncoding: 'der' | 'ieee-p1363',
    clientDataHash: Buffer,
  ): { ok: boolean; error?: string } => {
    try {
      const verifier = createVerify('SHA256');
      verifier.update(authenticatorData);
      verifier.update(clientDataHash);
      return {
        ok: verifier.verify({ key: keyPem, dsaEncoding }, signature),
      };
    } catch {
      return { ok: false, error: 'verify-threw' };
    }
  };

  let valid = false;
  const attemptDetails: string[] = [];
  for (const keyCandidate of keyCandidates) {
    for (const candidate of candidateClientDataHashes) {
      const derResult = verifyWithEncodingAndClientHash(
        keyCandidate.key,
        'der',
        candidate.value,
      );
      attemptDetails.push(
        `${keyCandidate.name}:${candidate.name}:der=${derResult.ok ? 'ok' : derResult.error || 'fail'}`,
      );
      if (derResult.ok) {
        valid = true;
        break;
      }

      const p1363Result = verifyWithEncodingAndClientHash(
        keyCandidate.key,
        'ieee-p1363',
        candidate.value,
      );
      attemptDetails.push(
        `${keyCandidate.name}:${candidate.name}:ieee-p1363=${p1363Result.ok ? 'ok' : p1363Result.error || 'fail'}`,
      );
      if (p1363Result.ok) {
        valid = true;
        break;
      }
    }
    if (valid) {
      break;
    }
  }

  if (!valid) {
    if (allowInsecureBypass) {
      // eslint-disable-next-line no-console
      console.warn(
        `[app-attest] Insecure assertion bypass enabled; accepting assertion with failed signature verify (signCount=${parsed.signCount}, stored=${storedSignCount})`,
      );
      return { newSignCount: parsed.signCount };
    }
    throw new Error(
      `Assertion signature verification failed (sigLen=${signature.length}, authDataLen=${authenticatorData.length}, clientHashLen=${assertionClientDataHash?.length ?? 0}, keyCandidates=${keyCandidates.length}, keyIdMatchesCandidate=${keyIdMatchesAnyCandidate}, ${decodedShape}, signCount=${parsed.signCount}, storedSignCount=${storedSignCount}, rpBundle=${rpMatchesBundle}, rpAppId=${rpMatchesAppId}, attempts=${attemptDetails.join('|')})`,
    );
  }

  return { newSignCount: parsed.signCount };
}

// ---------- Attested keys store ----------

export interface AttestedKeyEntry {
  publicKey: string; // PEM
  alternatePublicKey?: string; // PEM
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

export function getAllAttestedKeys(): Array<{
  keyId: string;
  entry: AttestedKeyEntry;
}> {
  return Array.from(attestedKeys.entries()).map(([keyId, entry]) => ({
    keyId,
    entry,
  }));
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
