import {
  randomBytes,
  createHash,
  X509Certificate,
  createVerify,
  verify as cryptoVerify,
  createPublicKey,
} from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode, decodeMultiple } from 'cbor-x';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Nonce store ----------

const NONCE_TTL_MS = 60_000;

/**
 * Hard ceiling on outstanding challenges (MWP-95).
 *
 * `/attest/challenge` is unauthenticated, so this map is the one piece of
 * server state an anonymous caller can grow directly. TTL alone does not
 * bound it: expiry is 60s, so the ceiling was however many nonces a caller
 * could request in 60 seconds — unbounded in practice. The per-source rate
 * limit in wsproxy.ts is the first line; this is the backstop for a
 * distributed caller that stays under it from many addresses.
 *
 * 10k nonces is roughly 1 MB and far above any real fleet's 60-second
 * demand, since a client asks for one nonce per connect.
 */
const MAX_CHALLENGES = 10_000;
const challenges = new Map<string, number>(); // nonce → expiry timestamp

/** Drop every entry past its TTL. */
function evictExpiredChallenges(now: number): void {
  for (const [n, exp] of challenges) {
    if (now > exp) challenges.delete(n);
  }
}

export function generateChallenge(): string {
  const now = Date.now();
  evictExpiredChallenges(now);

  // If eviction did not get us under the ceiling, every remaining nonce is
  // live and we are under load or under attack. Drop the oldest — Map
  // iterates in insertion order, and insertion order is expiry order because
  // the TTL is constant — rather than refusing to issue, which would let a
  // flood deny registration to legitimate clients.
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next();
    if (oldest.done) break;
    challenges.delete(oldest.value);
  }

  const nonce = randomBytes(32).toString('hex');
  challenges.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

/** Outstanding challenge count. Exposed for tests and diagnostics. */
export function challengeCount(): number {
  return challenges.size;
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
    try {
      credentialPublicKey = decode(attestedDataTail);
    } catch {
      // Both decoders failed, so it stays at its initial null and the
      // verifier continues with the cert key path.
    }
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
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
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

function getCoseMapValue(coseKey: unknown, numericKey: number): unknown {
  if (
    typeof coseKey === 'object' &&
    coseKey !== null &&
    'value' in (coseKey as Record<string, unknown>)
  ) {
    const tagged = (coseKey as { value?: unknown }).value;
    if (tagged !== undefined && tagged !== coseKey) {
      return getCoseMapValue(tagged, numericKey);
    }
  }

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
  let normalizedKey = coseKey;
  // Some decoders may leave the COSE key as an encoded byte string.
  if (Buffer.isBuffer(normalizedKey) || normalizedKey instanceof Uint8Array) {
    try {
      normalizedKey = decode(Buffer.from(normalizedKey));
    } catch {
      // Keep original value and fail with a precise error below.
    }
  }

  const x = getCoseMapValue(normalizedKey, -2);
  const y = getCoseMapValue(normalizedKey, -3);

  const xBuf = Buffer.isBuffer(x)
    ? x
    : x
      ? Buffer.from(x as Uint8Array)
      : null;
  const yBuf = Buffer.isBuffer(y)
    ? y
    : y
      ? Buffer.from(y as Uint8Array)
      : null;

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
  keySource: 'cose' | 'cert';
  keyIdMatchesCertHash: boolean;
  keyIdMatchesCoseHash: boolean;
  coseKeyExtracted: boolean;
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
  const secondaryCertPublicKeyPem =
    certs.length > 1
      ? certs[1].publicKey.export({ type: 'spki', format: 'pem' }).toString()
      : null;

  // Both are assigned on every path: the try completes, or the catch resets
  // them. The reset is not redundant — the try can throw after the PEM is
  // set but before the digest exists, and callers must never see a
  // half-derived COSE key.
  let cosePublicKeyPem: string | null;
  let coseCredId: Buffer | null;
  try {
    cosePublicKeyPem = coseEcP256ToPem(parsed.credentialPublicKey);
    const cosePublicKeyDer = Buffer.from(
      createPublicKey(cosePublicKeyPem).export({
        type: 'spki',
        format: 'der',
      }) as unknown as ArrayBuffer,
    );
    coseCredId = createHash('sha256').update(cosePublicKeyDer).digest();
  } catch {
    cosePublicKeyPem = null;
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

  const keyIdMatchesCertHash =
    keyId === expectedCredIdFromCert.toString('base64') ||
    keyId === toBase64Url(expectedCredIdFromCert);
  const keyIdMatchesCoseHash =
    !!expectedCredIdFromCose &&
    (keyId === expectedCredIdFromCose.toString('base64') ||
      keyId === toBase64Url(expectedCredIdFromCose));

  // Prefer the credential public key carried in authData (COSE key).
  // Assertion signatures are produced by that credential key.
  const publicKeyPem = cosePublicKeyPem ? cosePublicKeyPem : certPublicKeyPem;
  let alternatePublicKey: string | undefined = cosePublicKeyPem
    ? certPublicKeyPem
    : undefined;

  if (!keyIdMatchesCoseHash && !keyIdMatchesCertHash) {
    // eslint-disable-next-line no-console
    console.warn(
      '[app-attest] keyId does not match hash of cert or COSE public key; storing available candidates for assertion-time verification',
    );
  }

  if (
    (!alternatePublicKey || alternatePublicKey === publicKeyPem) &&
    secondaryCertPublicKeyPem &&
    secondaryCertPublicKeyPem !== publicKeyPem
  ) {
    alternatePublicKey = secondaryCertPublicKeyPem;
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
    alternatePublicKey:
      alternatePublicKey && alternatePublicKey !== publicKeyPem
        ? alternatePublicKey
        : undefined,
    keyId,
    keySource: cosePublicKeyPem ? 'cose' : 'cert',
    keyIdMatchesCertHash,
    keyIdMatchesCoseHash,
    coseKeyExtracted: Boolean(cosePublicKeyPem),
  };
}

// ---------- Assertion verification ----------

export interface AssertionInput {
  assertionBuffer: Buffer;
  keyId?: string;
  nonce: string; // hex
  explicitClientDataHash?: Buffer;
  bundleId: string;
  teamId?: string;
  storedPublicKey: string; // PEM
  alternatePublicKey?: string; // PEM
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
    keyId,
    nonce,
    explicitClientDataHash,
    bundleId,
    teamId,
    storedPublicKey,
    alternatePublicKey,
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
    ? createHash('sha256').update(`${teamId}.${bundleId}`).digest()
    : null;
  const rpMatchesBundle = parsed.rpIdHash.equals(expectedBundleHash);
  const rpMatchesAppId =
    !!expectedAppIdHash && parsed.rpIdHash.equals(expectedAppIdHash);
  if (!rpMatchesBundle && !rpMatchesAppId) {
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
  if (explicitClientDataHash) {
    candidateClientDataHashes.push({
      name: 'explicitClientHash',
      value: explicitClientDataHash,
    });
  }
  if (assertionClientDataHash) {
    candidateClientDataHashes.push({
      name: 'assertionClientDataHash',
      value: assertionClientDataHash,
    });
  }
  candidateClientDataHashes.push(
    {
      name: 'sha256NonceBytes',
      value: createHash('sha256').update(nonceBytes).digest(),
    },
    {
      name: 'sha256sha256NonceBytes',
      value: createHash('sha256')
        .update(createHash('sha256').update(nonceBytes).digest())
        .digest(),
    },
    { name: 'rawNonceBytes', value: nonceBytes },
    {
      name: 'sha256NonceUtf8',
      value: createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest(),
    },
    {
      name: 'sha256sha256NonceUtf8',
      value: createHash('sha256')
        .update(
          createHash('sha256').update(Buffer.from(nonce, 'utf8')).digest(),
        )
        .digest(),
    },
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

  const verifyWithEncodingAndPayload = (
    keyPem: string,
    dsaEncoding: 'der' | 'ieee-p1363',
    payload: Buffer,
    mode: 'sha256' | 'raw',
  ): { ok: boolean; error?: string } => {
    try {
      if (mode === 'raw') {
        return {
          ok: cryptoVerify(
            null,
            payload,
            { key: keyPem, dsaEncoding },
            signature,
          ),
        };
      }

      const verifier = createVerify('SHA256');
      verifier.update(payload);
      return {
        ok: verifier.verify({ key: keyPem, dsaEncoding }, signature),
      };
    } catch (err) {
      return {
        ok: false,
        error: `verify-threw:${(err as Error).message}`,
      };
    }
  };

  const buildPayloadVariants = (
    clientDataHash: Buffer,
  ): Array<{ name: string; payload: Buffer; mode: 'sha256' | 'raw' }> => {
    const authPlusClient = Buffer.concat([authenticatorData, clientDataHash]);
    const clientPlusAuth = Buffer.concat([clientDataHash, authenticatorData]);
    return [
      {
        name: 'authPlusClient:sha256',
        payload: authPlusClient,
        mode: 'sha256',
      },
      {
        name: 'clientPlusAuth:sha256',
        payload: clientPlusAuth,
        mode: 'sha256',
      },
      { name: 'authPlusClient:raw', payload: authPlusClient, mode: 'raw' },
      { name: 'clientPlusAuth:raw', payload: clientPlusAuth, mode: 'raw' },
      {
        name: 'sha256(authPlusClient):raw',
        payload: createHash('sha256').update(authPlusClient).digest(),
        mode: 'raw',
      },
      {
        name: 'sha256(clientPlusAuth):raw',
        payload: createHash('sha256').update(clientPlusAuth).digest(),
        mode: 'raw',
      },
      { name: 'clientOnly:sha256', payload: clientDataHash, mode: 'sha256' },
      { name: 'clientOnly:raw', payload: clientDataHash, mode: 'raw' },
    ];
  };

  let valid = false;
  const attemptDetails: string[] = [];
  for (const keyCandidate of keyCandidates) {
    for (const candidate of candidateClientDataHashes) {
      for (const payloadVariant of buildPayloadVariants(candidate.value)) {
        const derResult = verifyWithEncodingAndPayload(
          keyCandidate.key,
          'der',
          payloadVariant.payload,
          payloadVariant.mode,
        );
        attemptDetails.push(
          `${keyCandidate.name}:${candidate.name}:${payloadVariant.name}:der=${derResult.ok ? 'ok' : derResult.error || 'fail'}`,
        );
        if (derResult.ok) {
          valid = true;
          break;
        }

        const p1363Result = verifyWithEncodingAndPayload(
          keyCandidate.key,
          'ieee-p1363',
          payloadVariant.payload,
          payloadVariant.mode,
        );
        attemptDetails.push(
          `${keyCandidate.name}:${candidate.name}:${payloadVariant.name}:ieee-p1363=${p1363Result.ok ? 'ok' : p1363Result.error || 'fail'}`,
        );
        if (p1363Result.ok) {
          valid = true;
          break;
        }
      }
      if (valid) {
        break;
      }
      const derResult = verifyWithEncodingAndPayload(
        keyCandidate.key,
        'der',
        Buffer.concat([authenticatorData, candidate.value]),
        'sha256',
      );
      attemptDetails.push(
        `${keyCandidate.name}:${candidate.name}:legacyAuthPlusClient:der=${derResult.ok ? 'ok' : derResult.error || 'fail'}`,
      );
      if (derResult.ok) {
        valid = true;
        break;
      }

      const p1363Result = verifyWithEncodingAndPayload(
        keyCandidate.key,
        'ieee-p1363',
        Buffer.concat([authenticatorData, candidate.value]),
        'sha256',
      );
      attemptDetails.push(
        `${keyCandidate.name}:${candidate.name}:legacyAuthPlusClient:ieee-p1363=${p1363Result.ok ? 'ok' : p1363Result.error || 'fail'}`,
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
    // A failed signature is the end of the road. MWP-95 removed the opt-in
    // escape hatch that used to return success here: an assertion that does
    // not verify carries no evidence about the device that sent it, so
    // accepting one makes App Attest a decorative header check. There is
    // deliberately no flag, test hook, or environment variable that reaches
    // this branch — if you are adding one, you are removing the feature.
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
  /**
   * ISO timestamp of the last successful assertion. Absent on entries
   * written before MWP-95, which fall back to `registeredAt` for TTL.
   */
  lastUsedAt?: string;
}

/**
 * Bounds on the attested-key store (MWP-95).
 *
 * Registration is unauthenticated — it is gated by a valid Apple attestation,
 * not by a credential we issued — so without a ceiling the store grows with
 * every device that ever connects and is never reclaimed. The TTL reclaims
 * keys belonging to devices that stopped coming back: an uninstalled app, a
 * replaced phone. A returning client past the TTL re-registers, which is one
 * extra round trip, not a failure.
 */
const MAX_ATTESTED_KEYS = 10_000;
const ATTESTED_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const attestedKeys = new Map<string, AttestedKeyEntry>();

/** When an entry was last useful, for TTL purposes. */
function lastActivity(entry: AttestedKeyEntry): number {
  const stamp = Date.parse(entry.lastUsedAt ?? entry.registeredAt);
  // An unparseable timestamp must not read as "epoch, evict immediately" —
  // that would silently discard a usable key on a malformed file.
  return Number.isNaN(stamp) ? Date.now() : stamp;
}

/** Drop entries whose last activity is older than the TTL. */
function evictStaleKeys(now: number): void {
  for (const [keyId, entry] of attestedKeys) {
    if (now - lastActivity(entry) > ATTESTED_KEY_TTL_MS) {
      attestedKeys.delete(keyId);
    }
  }
}

export function getAttestedKey(keyId: string): AttestedKeyEntry | undefined {
  return attestedKeys.get(keyId);
}

export function setAttestedKey(keyId: string, entry: AttestedKeyEntry): void {
  const now = Date.now();
  evictStaleKeys(now);

  // Replacing an existing key never grows the store, so only a genuinely new
  // keyId needs to make room.
  if (!attestedKeys.has(keyId)) {
    while (attestedKeys.size >= MAX_ATTESTED_KEYS) {
      // Evict least-recently-active rather than oldest-inserted: a long-lived
      // device that still connects daily should outlive one that registered
      // yesterday and vanished.
      let stalestKey: string | null = null;
      let stalestAt = Infinity;
      for (const [candidateId, candidate] of attestedKeys) {
        const activity = lastActivity(candidate);
        if (activity < stalestAt) {
          stalestAt = activity;
          stalestKey = candidateId;
        }
      }
      if (stalestKey === null) break;
      attestedKeys.delete(stalestKey);
    }
  }

  attestedKeys.set(keyId, entry);
}

/** Registered key count. Exposed for tests and diagnostics. */
export function attestedKeyCount(): number {
  return attestedKeys.size;
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
  if (!entry) return;
  entry.signCount = newCount;
  // This is the only "the device is still here" signal we get, and it is what
  // keeps an active key from aging out under the TTL.
  entry.lastUsedAt = new Date().toISOString();
}

export function loadAttestedKeys(filePath: string): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, AttestedKeyEntry>;
    const now = Date.now();
    const nowStamp = new Date(now).toISOString();

    const migrated = Object.entries(obj).map(
      ([keyId, entry]): [string, AttestedKeyEntry] => {
        if (entry.lastUsedAt) return [keyId, entry];
        // Grandfather entries written before the TTL existed.
        //
        // Every key in a file from an earlier version lacks `lastUsedAt`, and
        // inferring inactivity from `registeredAt` would evict a device that
        // registered four months ago and connected this morning — the whole
        // established fleet, on the first restart after upgrade. Those clients
        // cache their keyId in the Keychain and skip registration, so they do
        // not re-register on their own; they just start failing with
        // "Unknown key".
        //
        // Starting their clock at load instead grants a genuinely abandoned
        // key one extra TTL window. That is a bounded, one-time cost, and the
        // wrong direction to err in is the other one.
        return [keyId, { ...entry, lastUsedAt: nowStamp }];
      },
    );

    const entries = migrated
      // Apply the TTL at load too. A file written before a long outage would
      // otherwise reintroduce keys the running process would have reclaimed,
      // and restore the store above its ceiling.
      .filter(([, entry]) => now - lastActivity(entry) <= ATTESTED_KEY_TTL_MS)
      // Keep the most recently active when the file exceeds the ceiling.
      .sort(([, a], [, b]) => lastActivity(b) - lastActivity(a))
      .slice(0, MAX_ATTESTED_KEYS);

    for (const [keyId, entry] of entries) {
      attestedKeys.set(keyId, entry);
    }
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }
}

/**
 * Persist the key store atomically (MWP-95).
 *
 * `writeFileSync` on the live path truncates it first, so a crash, a full
 * disk, or a container stop mid-write leaves a truncated file — and
 * `loadAttestedKeys` treats unparseable JSON as "start fresh", silently
 * deregistering every device. Writing a sibling temp file and renaming makes
 * the swap atomic on POSIX: readers see either the old file or the new one.
 *
 * Staging happens in a private sibling directory rather than in /tmp, because
 * rename(2) is only atomic within a filesystem.
 */
export function saveAttestedKeys(filePath: string): void {
  const obj: Record<string, AttestedKeyEntry> = {};
  for (const [keyId, entry] of attestedKeys) {
    obj[keyId] = entry;
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Stage inside a directory from mkdtemp rather than at a sibling path of
  // our own naming. mkdtemp creates the directory atomically, with a random
  // name and mode 0700, which removes the race rather than narrowing it:
  // nothing else can pre-create, symlink, or even list the file we are about
  // to write. A self-named temp path — however random — is still a path an
  // attacker may reach first if the containing directory is writable, and
  // ATTESTED_KEYS_PATH is operator-supplied, so that directory is not always
  // one we control.
  const stagingDir = fs.mkdtempSync(path.join(dir, '.attested-keys-'));
  const tempPath = path.join(stagingDir, 'keys.json');

  try {
    // 'wx' is O_CREAT|O_EXCL — redundant inside a private directory, kept so
    // the guarantee does not depend solely on mkdtemp's mode.
    const handle = fs.openSync(tempPath, 'wx');
    try {
      // fsync before rename: rename is atomic with respect to the directory
      // entry, but without the flush the new file's contents may still be in
      // page cache when the machine loses power, leaving an intact name over
      // empty data.
      fs.writeFileSync(handle, JSON.stringify(obj, null, 2), 'utf-8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tempPath, filePath);
  } finally {
    // Runs whether or not the rename happened, so a failed save leaves the
    // previous file in place and no staging residue. The error propagates.
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Nothing to clean up.
    }
  }
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
