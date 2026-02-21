# iOS App Authentication Design

**Date:** 2026-02-17
**Status:** Approved
**Goal:** Restrict WebSocket connections to the mud-web-proxy so that only the official iOS app can connect.

## Problem

The proxy currently accepts any WebSocket connection that passes the `ALLOWED_ORIGINS` origin header check. Origin headers are trivially set by any client, so this provides no real protection against bots, scrapers, or third-party apps connecting to the MUD server through the proxy.

## Solution Overview

Two complementary layers:

1. **Apple App Attest** (production/release builds): Apple cryptographically certifies that a request originates from a genuine, unmodified copy of the specified app. The private key lives in the iOS Secure Enclave and can never be extracted.

2. **Mutual TLS (mTLS) fallback** (simulator/debug builds only): A client TLS certificate embedded in the debug app proves the client is a known developer build. This fallback is disabled in production and only allowed when explicitly enabled for simulator/debug workflows.

A `REQUIRE_APP_AUTH` env var (default `true`) enables/disables the gate. Set to `false` only for local/test workflows.

## Deployment Assumptions (Current Phase)

- Single proxy instance only (no shared nonce/key backend yet)
- In-memory nonce store is authoritative for replay protection
- `config/attested-keys.json` is local-node state
- Horizontal scaling is intentionally out of scope for this phase

## App Attest Flow

### Phase A — Registration (one-time per device)

Registration happens once per device/app-install. The result is a stored public key associated with the device's App Attest key ID.

```
iOS App                        Proxy Server                   Apple
   |                               |                              |
   |-- GET /attest/challenge ----→ |                              |
   |←-- {nonce, expires} --------- |                              |
   |                               |                              |
   |   generateKey() → keyId       |                              |
   |   attestKey(keyId,            |                              |
   |     SHA256(nonce)) ----------------------------------------→ |
   |←-- attestation object --------------------------------------- |
   |                               |                              |
   |-- POST /attest/register --→   |                              |
   |   {keyId, attestation,        | verify cert chain against    |
   |    clientData: nonce}         | Apple root CA                |
   |                               | confirm bundleId + teamId    |
   |                               | extract public key from cert |
   |                               | store keyId → pubKey + count |
   |←-- {registered: true} ------- |                              |
   |   (store keyId in Keychain)   |                              |
```

### Phase B — Per-connection Assertion

Before each WebSocket connection, the app obtains a fresh challenge and signs it.

```
iOS App                        Proxy Server
   |                               |
   |-- GET /attest/challenge ----→ |
   |←-- {nonce} ------------------|
   |                               |
   |   generateAssertion(keyId,    |
   |     SHA256(nonce))            |
   |                               |
   |-- WS Upgrade with headers:    |
   |   X-App-Assert-KeyId: <id>    | look up pubKey for keyId
   |   X-App-Assert-Data: <b64>    | verify ECDSA signature
   |   X-App-Assert-Nonce: <nonce> | check nonce not expired/used
   |                               | delete nonce (single-use)
   |                               | verify signCount increased
   |←-- 101 Switching Protocols -- | update stored signCount
```

**Nonce properties:**
- 32 bytes, cryptographically random
- Expires after 60 seconds
- Single-use: deleted from server after first verification
- Prevents replay attacks

### Attestation Verification (server-side)

On `POST /attest/register`:
1. Decode CBOR attestation object
2. Verify `fmt == "apple-appattest"`
3. Verify certificate chain (`x5c`) against Apple App Attest root CA
4. Confirm `bundleId` and `teamId` in cert match configured values
5. Verify `authData.rpIdHash == SHA256(bundleId)`
6. Verify `credentialId == SHA256(publicKey)`
7. Verify nonce embedded in cert == `SHA256(authData || clientDataHash)`
8. Store: `keyId → { publicKey (PEM), signCount: 0, registeredAt }`

On assertion verification (WebSocket connection):
1. Decode CBOR assertion object
2. Verify `authData.rpIdHash == SHA256(bundleId)`
3. Verify `authData.signCount > stored signCount` (strictly increasing)
4. Reconstruct `nonce = SHA256(authenticatorData || SHA256(clientData))`
5. Verify ECDSA-P256 signature over nonce using stored public key
6. Update stored signCount

## mTLS Fallback (Simulator / Debug Builds)

For simulator builds where `DCAppAttestService` is unavailable:

- A private CA is generated offline (e.g., `openssl req -new -x509 ...`) and stored in `config/client-ca/` (gitignored).
- A client certificate + private key are generated, signed by the private CA, and bundled into the Xcode project under `#if DEBUG` conditional compilation.
- The proxy's HTTPS server is configured with `requestCert: true` and `ca: clientCACert`.
- Fallback is only active when `ALLOW_MTLS_FALLBACK=true` and `NODE_ENV !== "production"`.
- In the WebSocket **upgrade** path: if no `X-App-Assert-*` headers are present and fallback is active, check `(req.socket as tls.TLSSocket).authorized`. If `true` → allow; otherwise → reject.

## Attestation Storage

Registered keys are persisted to `config/attested-keys.json` (gitignored), loaded at startup. Format:

```json
{
  "keyId1": {
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
    "signCount": 12,
    "registeredAt": "2026-02-17T00:00:00.000Z"
  }
}
```

Writes are debounced (similar to chat log persistence already in the codebase).

## New Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REQUIRE_APP_AUTH` | `true` | Enable/disable app authentication gate |
| `APPATTEST_BUNDLE_ID` | — | iOS app bundle ID (e.g. `com.example.mudapp`) |
| `APPATTEST_TEAM_ID` | — | Apple Developer Team ID (10 chars) |
| `ALLOW_MTLS_FALLBACK` | `false` | Enable mTLS fallback for simulator/debug only; ignored in production |
| `MTLS_CLIENT_CA_PATH` | — | Path to client CA cert PEM for mTLS fallback |
| `ATTESTED_KEYS_PATH` | `./config/attested-keys.json` | Where to persist registered key store |

## New HTTP Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/attest/challenge` | None | Returns a fresh nonce for Attest or mTLS |
| `POST` | `/attest/register` | None (verified by content) | Verifies attestation, stores public key |

Both endpoints are served on the same HTTPS port as the WebSocket server.

## Changes to wsproxy.ts

1. Add `/attest/challenge` and `/attest/register` handlers to the HTTPS server's `request` event.
2. Add in-memory nonce store (Map<nonce, expiry>), with periodic cleanup of expired entries.
3. Load `attested-keys.json` at startup (if present).
4. Add `CBOR` decoding dependency (`cbor-x` package) and attestation verification logic.
5. In the HTTP `upgrade` path (before WebSocket accept):
   - If `REQUIRE_APP_AUTH` is falsy → allow.
   - If `X-App-Assert-*` headers present → run assertion verification → allow or reject.
   - Assertion path must validate and consume the nonce (single-use).
   - Else if mTLS fallback is explicitly enabled (`ALLOW_MTLS_FALLBACK=true`, non-production) and client cert is authorized (`req.socket.authorized`) → allow.
   - Else → terminate with a 401-equivalent close.
6. Persist key store on each new registration (debounced).

## Dependencies

- `cbor-x` — CBOR decoding (attestation/assertion objects are CBOR-encoded)
- Apple App Attest Root CA certificate — bundled in the repo as a static PEM (publicly available)

## Testing

- Unit tests: attestation verification logic with known-good test vectors from Apple's documentation.
- Integration test: mock attestation flow verifying the full register → connect pipeline.
- The `REQUIRE_APP_AUTH=false` env var allows existing tests to continue running without certificates.

## iOS App Changes (out of scope for this doc)

- Call `DCAppAttestService.shared.generateKey()` and store `keyId` in Keychain.
- Call `GET /attest/challenge` → sign with `attestKey()` → `POST /attest/register`.
- Before each WebSocket connection: `GET /attest/challenge` → `generateAssertion()` → set headers.
- Simulator builds: load `.p12` from bundle, configure `URLSessionDelegate` for client cert challenge.
