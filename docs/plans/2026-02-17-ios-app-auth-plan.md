# iOS App Authentication (App Attest + mTLS) Implementation Plan

**Goal:** Restrict WebSocket connections to the proxy so that only the official iOS app can connect, using Apple App Attest for release builds and mutual TLS for simulator/debug builds.

**Architecture:** A new `src/app-attest.ts` module handles nonce generation, attestation verification (CBOR + X.509 chain), assertion verification (ECDSA), and key persistence. Two new HTTP endpoints (`GET /attest/challenge`, `POST /attest/register`) are added to the existing request handler in `wsproxy.ts`. Authentication checks run in the HTTP `upgrade` path (before WebSocket acceptance), and assertion nonces are validated + consumed (single-use) before signature verification.

**Tech Stack:** Node.js `crypto` module (X509Certificate, createVerify, randomBytes), `cbor-x` (CBOR decoding), Bun test framework.

## Current-Phase Assumptions

- Single proxy instance deployment (no shared Redis/DB state)
- Nonce replay protection is in-memory per instance
- `attested-keys.json` is local node state
- Multi-instance synchronization is out of scope for this phase

---

## Pre-reading

Before starting, read:
- `wsproxy.ts` lines 836–930 — the HTTP request handler and WebSocket connection handler
- `src/app-attest.ts` doesn't exist yet
- Design doc: `docs/plans/2026-02-17-ios-app-auth-design.md`

---

## Task 1: Install cbor-x and bundle Apple root CA

**Files:**
- Modify: `package.json` (dependency added by bun)
- Create: `config/apple-app-attest-root-ca.pem`

### Step 1: Install cbor-x

```bash
bun add cbor-x
```

Expected: `cbor-x` appears in `dependencies` in `package.json`.

### Step 2: Download Apple App Attest root CA

Fetch the Apple App Attest Root CA PEM from Apple's certificate authority page:
https://www.apple.com/certificateauthority/Apple_App_Attest_Root_CA.pem

Save it to `config/apple-app-attest-root-ca.pem`. The file begins with `-----BEGIN CERTIFICATE-----`.

Create the config directory if needed:
```bash
mkdir -p config
```

### Step 3: Add config/ to .gitignore only for secrets, not for the CA

The CA cert is public and should be committed. The keys file should be gitignored:

```bash
echo "config/attested-keys.json" >> .gitignore
echo "config/client-ca/" >> .gitignore
```

### Step 4: Verify cbor-x decodes correctly

```bash
bun -e "import { decode } from 'cbor-x'; console.log(decode(Buffer.from([0xa1, 0x61, 0x61, 0x01])));"
```

Expected output: `{ a: 1 }`

### Step 5: Commit

```bash
git add config/apple-app-attest-root-ca.pem .gitignore package.json bun.lock
git commit -m "feat: add cbor-x dependency and Apple App Attest root CA cert"
```

---

## Task 2: Create `src/app-attest.ts` — nonce management

**Files:**
- Create: `src/app-attest.ts`
- Create: `tests/app-attest-nonce.test.ts`

### Step 1: Write failing tests for nonce management

Create `tests/app-attest-nonce.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  generateChallenge,
  validateAndConsumeNonce,
  _resetNoncesForTesting,
} from '../src/app-attest';

describe('nonce management', () => {
  beforeEach(() => {
    _resetNoncesForTesting();
  });

  test('generateChallenge returns 64-char hex string', () => {
    const nonce = generateChallenge();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  test('validateAndConsumeNonce returns true for valid nonce', () => {
    const nonce = generateChallenge();
    expect(validateAndConsumeNonce(nonce)).toBe(true);
  });

  test('validateAndConsumeNonce returns false for unknown nonce', () => {
    expect(validateAndConsumeNonce('deadbeef')).toBe(false);
  });

  test('validateAndConsumeNonce is single-use (replay protection)', () => {
    const nonce = generateChallenge();
    expect(validateAndConsumeNonce(nonce)).toBe(true);
    expect(validateAndConsumeNonce(nonce)).toBe(false);
  });

  test('each generateChallenge returns a unique nonce', () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(a).not.toBe(b);
  });
});
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/app-attest-nonce.test.ts
```

Expected: FAIL — "Cannot find module '../src/app-attest'"

### Step 3: Create `src/app-attest.ts` with nonce management

```typescript
import { randomBytes, createHash, createVerify, X509Certificate } from 'crypto';
import fs from 'fs';
import path from 'path';
import { decode } from 'cbor-x';
import { fileURLToPath } from 'url';

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
```

### Step 4: Run tests to confirm they pass

```bash
bun test tests/app-attest-nonce.test.ts
```

Expected: PASS (5 tests)

### Step 5: Commit

```bash
git add src/app-attest.ts tests/app-attest-nonce.test.ts
git commit -m "feat: add nonce store for App Attest challenge flow"
```

---

## Task 3: Attestation verification — authData parsing

**Files:**
- Modify: `src/app-attest.ts`
- Create: `tests/app-attest-authdata.test.ts`

### Step 1: Write failing tests for authData parsing

Create `tests/app-attest-authdata.test.ts`:

```typescript
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
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/app-attest-authdata.test.ts
```

Expected: FAIL — parseAttestationAuthData not exported

### Step 3: Add authData parsers to `src/app-attest.ts`

Append to `src/app-attest.ts`:

```typescript
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
```

### Step 4: Run tests

```bash
bun test tests/app-attest-authdata.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
git add src/app-attest.ts tests/app-attest-authdata.test.ts
git commit -m "feat: add authData parsers for App Attest attestation and assertion"
```

---

## Task 4: Attestation verification — cert chain + nonce extraction

**Files:**
- Modify: `src/app-attest.ts`
- Create: `tests/app-attest-cert.test.ts`

### Step 1: Write failing tests for cert nonce extraction

Create `tests/app-attest-cert.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import {
  extractNonceFromCert,
  buildAppleNonceDer,
} from '../src/app-attest';

describe('extractNonceFromCert', () => {
  test('extracts 32-byte nonce from DER cert extension', () => {
    const nonce = Buffer.alloc(32, 0x42);
    // Build a minimal DER that contains the Apple nonce extension
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
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/app-attest-cert.test.ts
```

Expected: FAIL

### Step 3: Add cert nonce extraction to `src/app-attest.ts`

Note: `buildAppleNonceDer` is a test helper that generates a minimal DER buffer containing the Apple OID + nonce, so the extraction logic can be tested without a real certificate.

Append to `src/app-attest.ts`:

```typescript
// ---------- Certificate nonce extraction ----------

// OID 1.2.840.113635.100.8.2 in DER encoding
const APPLE_NONCE_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
]);

/**
 * Extract the 32-byte nonce from Apple App Attest credential cert.
 * Searches for OID 1.2.840.113635.100.8.2 in the raw DER bytes.
 * The extension value has structure: SEQUENCE { SEQUENCE { OCTET STRING <nonce> } }
 */
export function extractNonceFromCert(certDer: Buffer): Buffer {
  const oidIdx = certDer.indexOf(APPLE_NONCE_OID);
  if (oidIdx === -1) throw new Error('Apple nonce OID not found in certificate');

  let pos = oidIdx + APPLE_NONCE_OID.length;

  // Skip optional critical BOOLEAN (tag=0x01, length=0x01, value=0xff/0x00)
  if (certDer[pos] === 0x01 && certDer[pos + 1] === 0x01) pos += 3;

  // OCTET STRING wrapping the DER-encoded extension value
  if (certDer[pos] !== 0x04) throw new Error('Expected OCTET STRING after OID');
  pos += 1; // skip tag
  // Read length (handle short and long form)
  let extLen = certDer[pos++];
  if (extLen & 0x80) {
    const lenBytes = extLen & 0x7f;
    extLen = 0;
    for (let i = 0; i < lenBytes; i++) extLen = (extLen << 8) | certDer[pos++];
  }

  // Extension value: SEQUENCE { SEQUENCE { OCTET STRING <nonce> } }
  if (certDer[pos] !== 0x30) throw new Error('Expected outer SEQUENCE in extension value');
  pos += 2; // tag + length
  if (certDer[pos] !== 0x30) throw new Error('Expected inner SEQUENCE in extension value');
  pos += 2; // tag + length
  if (certDer[pos] !== 0x04) throw new Error('Expected OCTET STRING for nonce');
  pos += 1; // skip tag
  const nonceLen = certDer[pos++];

  return Buffer.from(certDer.subarray(pos, pos + nonceLen));
}

/**
 * Build a minimal DER buffer containing the Apple nonce OID and extension value.
 * For testing only — not a real certificate.
 */
export function buildAppleNonceDer(nonce: Buffer): Buffer {
  // OCTET STRING <nonce>: 04 20 <32 bytes>
  const innerOctet = Buffer.concat([Buffer.from([0x04, nonce.length]), nonce]);
  // SEQUENCE { innerOctet }: 30 22 ...
  const innerSeq = Buffer.concat([
    Buffer.from([0x30, innerOctet.length]),
    innerOctet,
  ]);
  // SEQUENCE { innerSeq }: 30 24 ...
  const outerSeq = Buffer.concat([
    Buffer.from([0x30, innerSeq.length]),
    innerSeq,
  ]);
  // OCTET STRING wrapping: 04 26 ...
  const extValue = Buffer.concat([
    Buffer.from([0x04, outerSeq.length]),
    outerSeq,
  ]);
  // OID + extValue
  return Buffer.concat([APPLE_NONCE_OID, extValue]);
}
```

### Step 4: Run tests

```bash
bun test tests/app-attest-cert.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
git add src/app-attest.ts tests/app-attest-cert.test.ts
git commit -m "feat: add Apple cert nonce extraction with DER parsing"
```

---

## Task 5: Full attestation verification function

**Files:**
- Modify: `src/app-attest.ts`
- Create: `tests/app-attest-verify.test.ts`

### Step 1: Write failing tests for verifyAttestation

These tests use a self-signed cert chain (no Apple dependency). The tests validate the logic, not the actual Apple CA.

Create `tests/app-attest-verify.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { createHash, generateKeyPairSync, createSign, X509Certificate } from 'crypto';
import { verifyAttestation } from '../src/app-attest';
import { encode } from 'cbor-x';

// We cannot test real Apple attestation without a device.
// Instead, test that verifyAttestation rejects malformed input.

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
        attestationBuffer: attestation,
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
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/app-attest-verify.test.ts
```

Expected: FAIL — verifyAttestation not exported

### Step 3: Add verifyAttestation to `src/app-attest.ts`

First, add the Apple root CA loading near the top of the file (after the imports):

```typescript
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
```

Then add the `verifyAttestation` function:

```typescript
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
  let obj: { fmt: string; attStmt: { x5c: Buffer[]; receipt: Buffer }; authData: Buffer };
  try {
    obj = decode(attestationBuffer) as typeof obj;
  } catch {
    throw new Error('Failed to decode attestation CBOR');
  }

  // 2. Validate format
  if (obj.fmt !== 'apple-appattest') {
    throw new Error(`Invalid attestation format: ${obj.fmt}`);
  }

  const { x5c, receipt: _receipt } = obj.attStmt;
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

  // Each cert must be verified by the next; last cert verified by root
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error(`Certificate ${i} not signed by certificate ${i + 1}`);
    }
  }
  if (!certs[certs.length - 1].verify(rootCert.publicKey)) {
    throw new Error('Certificate chain does not terminate at Apple root CA');
  }

  const credCert = certs[0];
  const credCertDer = x5c[0];

  // 4. Verify rpIdHash == SHA256(bundleId)
  const parsed = parseAttestationAuthData(authData);
  const expectedRpIdHash = createHash('sha256').update(bundleId).digest();
  if (!parsed.rpIdHash.equals(expectedRpIdHash)) {
    throw new Error('rpIdHash does not match bundleId');
  }

  // 5. Verify teamId + bundleId in cert subject (exact attribute parsing preferred)
  // Minimal check for this phase: both must be present in subject string.
  const expectedCN = `${teamId}.${bundleId}`;
  if (!credCert.subject.includes(teamId) || !credCert.subject.includes(bundleId)) {
    throw new Error(`Certificate subject does not match teamId/bundleId (expected ${expectedCN})`);
  }

  // 6. Extract public key from credential cert
  const publicKeyPem = credCert.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  // 7. Verify credId == SHA256(publicKey DER)
  const publicKeyDer = Buffer.from(
    credCert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
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
    .update(authData)
    .update(clientDataHash)
    .digest();
  const certNonce = extractNonceFromCert(credCertDer);
  if (!certNonce.equals(expectedCertNonce)) {
    throw new Error('Certificate nonce does not match expected value');
  }

  // 9. Verify keyId == base64(SHA256(publicKey DER))
  const expectedKeyId = createHash('sha256').update(publicKeyDer).digest('base64');
  if (keyId !== expectedKeyId) {
    throw new Error('keyId does not match SHA256(publicKey)');
  }

  return { publicKey: publicKeyPem, keyId };
}
```

### Step 4: Run tests

```bash
bun test tests/app-attest-verify.test.ts
```

Expected: PASS (the test inputs trigger error paths, which is correct — we can't test the happy path without a real Apple-signed attestation)

### Step 5: Typecheck

```bash
bun run typecheck
```

Fix any TypeScript errors before continuing.

### Step 6: Commit

```bash
git add src/app-attest.ts tests/app-attest-verify.test.ts
git commit -m "feat: implement App Attest attestation verification"
```

---

## Task 6: Assertion verification

**Files:**
- Modify: `src/app-attest.ts`
- Create: `tests/app-attest-assertion.test.ts`

### Step 1: Write failing tests for verifyAssertion

These tests use a real EC P-256 key pair (generated in the test) to produce a valid assertion, allowing end-to-end verification.

Create `tests/app-attest-assertion.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import {
  createHash,
  generateKeyPairSync,
  createSign,
  KeyObject,
} from 'crypto';
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
  return encode({ signature, authenticatorData });
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
    const assertionBuffer = makeAssertion(privateKey, nonce, 'com.attacker.app', 1);
    await expect(
      verifyAssertion({
        assertionBuffer,
        nonce,
        bundleId: BUNDLE_ID, // correct bundleId
        storedPublicKey: publicKeyPem,
        storedSignCount: 0,
      }),
    ).rejects.toThrow('rpIdHash');
  });

  test('rejects tampered signature', async () => {
    const nonce = 'd'.repeat(64);
    const assertionBuffer = makeAssertion(privateKey, nonce, BUNDLE_ID, 1);
    // Corrupt the assertion
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
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/app-attest-assertion.test.ts
```

Expected: FAIL — verifyAssertion not exported

### Step 3: Add verifyAssertion to `src/app-attest.ts`

Append to `src/app-attest.ts`:

```typescript
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
  const { assertionBuffer, nonce, bundleId, storedPublicKey, storedSignCount } =
    opts;

  // 1. Decode CBOR
  let obj: { signature: Buffer; authenticatorData: Buffer };
  try {
    obj = decode(assertionBuffer) as typeof obj;
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
  // Apple signs SHA256(authenticatorData || SHA256(nonce bytes))
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
```

### Step 4: Run tests

```bash
bun test tests/app-attest-assertion.test.ts
```

Expected: PASS (4 tests)

### Step 5: Commit

```bash
git add src/app-attest.ts tests/app-attest-assertion.test.ts
git commit -m "feat: implement App Attest assertion verification (ECDSA-P256)"
```

---

## Task 7: Attested keys persistence

**Files:**
- Modify: `src/app-attest.ts`
- Create: `tests/app-attest-keys.test.ts`

### Step 1: Write failing tests

Create `tests/app-attest-keys.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadAttestedKeys,
  saveAttestedKeys,
  getAttestedKey,
  setAttestedKey,
  updateSignCount,
  _resetKeysForTesting,
} from '../src/app-attest';

describe('attested keys store', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `attest-test-${Date.now()}.json`);
    _resetKeysForTesting();
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test('getAttestedKey returns undefined for unknown keyId', () => {
    expect(getAttestedKey('unknown')).toBeUndefined();
  });

  test('setAttestedKey and getAttestedKey round-trips', () => {
    setAttestedKey('key1', {
      publicKey: '---PEM---',
      signCount: 0,
      registeredAt: new Date().toISOString(),
    });
    const entry = getAttestedKey('key1');
    expect(entry?.publicKey).toBe('---PEM---');
    expect(entry?.signCount).toBe(0);
  });

  test('updateSignCount updates signCount', () => {
    setAttestedKey('key2', {
      publicKey: '---PEM---',
      signCount: 5,
      registeredAt: new Date().toISOString(),
    });
    updateSignCount('key2', 10);
    expect(getAttestedKey('key2')?.signCount).toBe(10);
  });

  test('saveAttestedKeys writes JSON file and loadAttestedKeys reads it back', () => {
    setAttestedKey('key3', {
      publicKey: '---PEM---',
      signCount: 3,
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    saveAttestedKeys(tmpFile);
    _resetKeysForTesting();
    loadAttestedKeys(tmpFile);
    expect(getAttestedKey('key3')?.signCount).toBe(3);
  });

  test('loadAttestedKeys is a no-op if file does not exist', () => {
    expect(() => loadAttestedKeys('/nonexistent/path.json')).not.toThrow();
  });
});
```

### Step 2: Run test to confirm it fails

```bash
bun test tests/app-attest-keys.test.ts
```

Expected: FAIL

### Step 3: Add key store to `src/app-attest.ts`

Append to `src/app-attest.ts`:

```typescript
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

/** Test helper: clear the in-memory key store. */
export function _resetKeysForTesting(): void {
  attestedKeys.clear();
}
```

### Step 4: Run tests

```bash
bun test tests/app-attest-keys.test.ts
```

Expected: PASS (5 tests)

### Step 5: Commit

```bash
git add src/app-attest.ts tests/app-attest-keys.test.ts
git commit -m "feat: add attested keys store with JSON persistence"
```

---

## Task 8: HTTP endpoints in wsproxy.ts

**Files:**
- Modify: `wsproxy.ts`

Add the following two endpoints to the existing `webserver.on('request', ...)` handler (around line 836). The handler currently ends after `/diagnostic/api`. Add these as two new `else if` branches before the closing `}`

### Step 1: Add required imports at the top of wsproxy.ts

Near the top of `wsproxy.ts`, after the existing imports, add:

```typescript
import {
  generateChallenge,
  validateAndConsumeNonce,
  verifyAttestation,
  verifyAssertion,
  loadAttestedKeys,
  saveAttestedKeys,
  getAttestedKey,
  setAttestedKey,
  updateSignCount,
} from './src/app-attest';
```

### Step 2: Load attested keys at startup

In `srv.init()`, after loading chat (find `loadChat()` or equivalent startup code), add:

```typescript
const attestedKeysPath = process.env.ATTESTED_KEYS_PATH || path.resolve(__dirname, 'config/attested-keys.json');
loadAttestedKeys(attestedKeysPath);
srv.logInfo(`Loaded attested keys from ${attestedKeysPath}`, undefined, 'init');
```

Add a debounced persistence helper in `wsproxy.ts` so key updates do not sync-write on every registration/assertion:

```typescript
let saveAttestedKeysTimer: NodeJS.Timeout | undefined;

function scheduleSaveAttestedKeys(): void {
  if (saveAttestedKeysTimer) clearTimeout(saveAttestedKeysTimer);
  saveAttestedKeysTimer = setTimeout(() => {
    saveAttestedKeys(attestedKeysPath);
    saveAttestedKeysTimer = undefined;
  }, 250);
}
```

### Step 3: Add GET /attest/challenge endpoint

In the `webserver.on('request', ...)` handler, add a new `else if` branch:

```typescript
} else if (req.method === 'GET' && req.url === '/attest/challenge') {
  const nonce = generateChallenge();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ nonce, expires: Date.now() + 60_000 }));
```

### Step 4: Add POST /attest/register endpoint

Add another `else if` branch:

```typescript
} else if (req.method === 'POST' && req.url === '/attest/register') {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
        keyId: string;
        attestation: string; // base64
        nonce: string; // hex
      };
      if (!body.keyId || !body.attestation || !body.nonce) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing keyId, attestation, or nonce' }));
        return;
      }
      if (!validateAndConsumeNonce(body.nonce)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired nonce' }));
        return;
      }
      const bundleId = process.env.APPATTEST_BUNDLE_ID ?? '';
      const teamId = process.env.APPATTEST_TEAM_ID ?? '';
      if (!bundleId || !teamId) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server not configured for App Attest' }));
        return;
      }
      const attestationBuffer = Buffer.from(body.attestation, 'base64');
      const result = await verifyAttestation({
        keyId: body.keyId,
        attestationBuffer,
        nonce: body.nonce,
        bundleId,
        teamId,
      });
      setAttestedKey(result.keyId, {
        publicKey: result.publicKey,
        signCount: 0,
        registeredAt: new Date().toISOString(),
      });
      scheduleSaveAttestedKeys();
      srv.logInfo(`Registered App Attest key: ${body.keyId}`, undefined, 'auth');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ registered: true }));
    } catch (err) {
      srv.logWarn(`Attestation registration failed: ${(err as Error).message}`, undefined, 'auth');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
```

### Step 5: Typecheck

```bash
bun run typecheck
```

Fix any TypeScript errors.

### Step 6: Commit

```bash
git add wsproxy.ts
git commit -m "feat: add /attest/challenge and /attest/register HTTP endpoints"
```

---

## Task 9: WebSocket connection gate

**Files:**
- Modify: `wsproxy.ts`

### Step 1: Add the gate to the HTTP upgrade handler (before accept)

Do auth checks in the HTTP `upgrade` path, before calling `wsServer.handleUpgrade(...)` / `wsServer.emit('connection', ...)`.

This ensures unauthenticated clients are rejected before a WebSocket session is established.

```typescript
if (process.env.REQUIRE_APP_AUTH === 'true') {
  const keyId = req.headers['x-app-assert-keyid'] as string | undefined;
  const assertionB64 = req.headers['x-app-assert-data'] as string | undefined;
  const nonce = req.headers['x-app-assert-nonce'] as string | undefined;

  if (keyId && assertionB64 && nonce) {
    // App Attest assertion path
    if (!validateAndConsumeNonce(nonce)) {
      srv.logWarn('Rejected: invalid/expired/reused assertion nonce', undefined, 'auth');
      rejectUpgrade(socket, 401, 'Invalid nonce');
      return;
    }
    const storedKey = getAttestedKey(keyId);
    if (!storedKey) {
      srv.logWarn(`Rejected: unknown App Attest keyId ${keyId}`, undefined, 'auth');
      rejectUpgrade(socket, 401, 'Unknown key');
      return;
    }
    try {
      const assertionBuffer = Buffer.from(assertionB64, 'base64');
      const bundleId = process.env.APPATTEST_BUNDLE_ID ?? '';
      const assertResult = await verifyAssertion({
        assertionBuffer,
        nonce,
        bundleId,
        storedPublicKey: storedKey.publicKey,
        storedSignCount: storedKey.signCount,
      });
      updateSignCount(keyId, assertResult.newSignCount);
      scheduleSaveAttestedKeys();
      srv.logInfo(`App Attest verified for keyId ${keyId}`, undefined, 'auth');
    } catch (err) {
      srv.logWarn(`App Attest assertion failed: ${(err as Error).message}`, undefined, 'auth');
      rejectUpgrade(socket, 401, 'Assertion verification failed');
      return;
    }
  } else {
    // mTLS fallback is simulator/debug only
    const mtlsAllowed =
      process.env.ALLOW_MTLS_FALLBACK === 'true' &&
      process.env.NODE_ENV !== 'production';
    if (!mtlsAllowed) {
      srv.logWarn('Rejected: App Attest headers missing and mTLS fallback disabled', undefined, 'auth');
      rejectUpgrade(socket, 401, 'App authentication required');
      return;
    }

    const tlsSocket = req.socket as TLSSocket;
    if (!tlsSocket.authorized) {
      srv.logWarn('Rejected: invalid mTLS client certificate', undefined, 'auth');
      rejectUpgrade(socket, 401, 'Invalid client certificate');
      return;
    }
    srv.logInfo('mTLS fallback accepted (non-production)', undefined, 'auth');
  }
}
```

### Step 2: Add required helpers/imports for upgrade rejection

Add a top-level type import:

```typescript
import type { TLSSocket } from 'tls';
```

Add a small helper to reject upgrades before WS accept:

```typescript
function rejectUpgrade(socket: Socket, code: number, message: string): void {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
```

### Step 3: Typecheck

```bash
bun run typecheck
```

Fix any TypeScript errors.

### Step 4: Run all existing unit tests

```bash
bun test tests/*.test.ts
```

Expected: All tests pass (they don't go through the auth gate because the WebSocket server isn't started in unit tests).

### Step 5: Commit

```bash
git add wsproxy.ts
git commit -m "feat: enforce App Attest in upgrade path with simulator-only mTLS fallback"
```

---

## Task 10: mTLS server configuration

**Files:**
- Modify: `wsproxy.ts`

### Step 1: Add mTLS options when HTTPS server is created

Find the section in `srv.init()` where `https.createServer(...)` is called (around line 770). Modify it to add mTLS options when both `MTLS_CLIENT_CA_PATH` and `ALLOW_MTLS_FALLBACK=true` are set.

Change:

```typescript
webserver = https.createServer({
  cert: cert,
  key: key,
});
```

To:

```typescript
const tlsOptions: import('https').ServerOptions = { cert, key };
const clientCaPath = process.env.MTLS_CLIENT_CA_PATH;
const allowMtlsFallback =
  process.env.ALLOW_MTLS_FALLBACK === 'true' &&
  process.env.NODE_ENV !== 'production';
if (clientCaPath && allowMtlsFallback) {
  try {
    const clientCa = fs.readFileSync(path.resolve(clientCaPath));
    tlsOptions.requestCert = true;
    tlsOptions.rejectUnauthorized = false; // We check manually in the connection handler
    tlsOptions.ca = clientCa;
    srv.logInfo('mTLS fallback enabled for non-production', undefined, 'init');
  } catch (err) {
    srv.logWarn(
      `Could not load client CA from ${clientCaPath}: ${(err as Error).message}`,
      undefined,
      'init',
    );
  }
}
webserver = https.createServer(tlsOptions);
```

### Step 2: Update .env.example

Add new env vars to `.env.example`:

```bash
# App authentication (restricts connections to the official iOS app)
# REQUIRE_APP_AUTH=true

# Apple App Attest
# APPATTEST_BUNDLE_ID=com.example.yourapp
# APPATTEST_TEAM_ID=AAABBBCCC1

# mTLS client certificate fallback (for simulator/debug builds)
# ALLOW_MTLS_FALLBACK=false
# MTLS_CLIENT_CA_PATH=./config/client-ca/ca.pem

# Path to persist attested keys (default: ./config/attested-keys.json)
# ATTESTED_KEYS_PATH=./config/attested-keys.json
```

### Step 3: Typecheck and test

```bash
bun run typecheck && bun test tests/*.test.ts
```

Expected: All pass.

### Step 4: Commit

```bash
git add wsproxy.ts .env.example
git commit -m "feat: add mTLS client cert verification option to HTTPS server"
```

---

## Task 11: Guard existing E2E and integration tests

**Files:**
- Check: `tests/e2e/connection-helper.ts` and other E2E tests

### Step 1: Verify test setup disables auth gate explicitly

`REQUIRE_APP_AUTH` defaults to `true` in this plan. Tests must explicitly disable it unless they are auth-specific.

Run the full test suite:

```bash
bun test tests/*.test.ts
```

Expected: All existing tests pass after test setup explicitly disables auth gate.

### Step 2: If any test fails due to the auth gate

Ensure `process.env.REQUIRE_APP_AUTH = 'false'` in `tests/setup.ts` `beforeAll` hook:

```typescript
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.REQUIRE_APP_AUTH = 'false'; // disable auth gate in tests
});
```

### Step 3: Run lint

```bash
bun run lint
```

Fix any lint errors. Common ones to watch for:
- `no-console` violations (use `srv.log()` instead)
- Unused variables

### Step 4: Final commit

```bash
git add .
git commit -m "feat: iOS app authentication via App Attest + mTLS complete"
```

---

## Environment Variable Reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `REQUIRE_APP_AUTH` | `true` | No | Set to `false` only for local/test workflows |
| `APPATTEST_BUNDLE_ID` | — | When auth enabled | iOS bundle ID, e.g. `com.example.mudapp` |
| `APPATTEST_TEAM_ID` | — | When auth enabled | Apple Developer team ID (10 chars) |
| `ALLOW_MTLS_FALLBACK` | `false` | No | Enables simulator/debug mTLS fallback; ignored in production |
| `MTLS_CLIENT_CA_PATH` | — | When mTLS fallback enabled | PEM path for mTLS client CA |
| `ATTESTED_KEYS_PATH` | `./config/attested-keys.json` | No | Key store path |

---

## iOS App Integration Notes (for reference)

The iOS app must:

1. **Register once per device:**
   ```swift
   let service = DCAppAttestService.shared
   let keyId = try await service.generateKey()
   let nonce = fetchChallenge() // GET /attest/challenge → nonce (hex)
   let nonceData = Data(hexString: nonce)!
   let clientDataHash = SHA256(nonceData) // as Data
   let attestation = try await service.attestKey(keyId, clientDataHash: clientDataHash)
   // POST /attest/register {keyId, attestation: attestation.base64, nonce}
   // Store keyId in Keychain
   ```

2. **Before each WebSocket connection:**
   ```swift
   let nonce = fetchChallenge() // GET /attest/challenge → nonce (hex)
   let nonceData = Data(hexString: nonce)!
   let clientDataHash = SHA256(nonceData)
   let assertion = try await service.generateAssertion(keyId, clientDataHash: clientDataHash)
   // Set headers on WebSocket upgrade:
   //   X-App-Assert-KeyId: keyId
   //   X-App-Assert-Data: assertion.base64EncodedString()
   //   X-App-Assert-Nonce: nonce
   ```

3. **For simulator builds** (`#if targetEnvironment(simulator)`):
   Load `.p12` from bundle, configure `URLSessionDelegate` with `URLCredential` for the TLS challenge.
