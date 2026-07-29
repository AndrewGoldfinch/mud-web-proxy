# iOS Client Integration Guide

This guide covers everything needed to connect an iOS app to mud-web-proxy with App Attest authentication enabled (`REQUIRE_APP_AUTH=true`).

> **App Attest is EXPERIMENTAL and optional.**
>
> It is **disabled by default**. Until you set both `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`, the `/attest/*` routes are not registered at all and return 404 — you can ignore this entire guide if you are not shipping an iOS app.
>
> The Apple attestation and assertion verification in `src/app-attest.ts` **has not received an independent cryptographic review**. It is a from-scratch implementation of Apple's format, and bugs in that kind of code are not self-announcing: a verifier that is too permissive still accepts every genuine client, so it looks like it works. Do not rely on App Attest as your only access control. Pair it with `AUTH_MODE=shared-secret`, which is checked first and independently.

## Overview

Apple App Attest is the only supported path, and it requires a physical device: the Secure Enclave holds a key pair, and Apple cryptographically proves it belongs to your genuine app binary.

Each WebSocket connection requires a fresh server challenge signed by the device. Registration (generating and attesting the key) happens once per device install and is stored in the iOS Keychain.

The Simulator cannot attest and there is no certificate-based fallback any more — see [Part 2](#part-2-simulator-and-debug-builds).

---

## Prerequisites

- Xcode project with a valid bundle ID and Apple Developer team
- App Attest capability enabled in your entitlements (`com.apple.developer.devicecheck.appattest-environment` set to `production` or `development`)
- Server running with `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID` set — both, or startup aborts — and `REQUIRE_APP_AUTH=true` once you are ready to enforce
- A physical iOS device. The Simulator cannot produce an attestation.

---

## Part 1: App Attest (Release / TestFlight Builds)

### 1.1 Required frameworks

```swift
import CryptoKit
import DeviceCheck
import Foundation
```

### 1.2 Registration (one-time per device)

Call this on first launch (or after a fresh install). Store the result in the Keychain — never regenerate unless the stored key is lost.

```swift
actor AppAttestManager {
    private let service = DCAppAttestService.shared
    private let keychainKey = "com.example.app.attestKeyId"

    // Call once on first launch. Idempotent — skips if already registered.
    func registerIfNeeded(proxyBaseURL: URL) async throws {
        if loadKeyId() != nil { return } // Already registered

        // 1. Generate a new Secure Enclave key pair
        let keyId = try await service.generateKey()

        // 2. Fetch a challenge from the proxy
        let nonce = try await fetchChallenge(from: proxyBaseURL)

        // 3. Hash the nonce bytes — Apple expects a Data hash, not raw nonce
        let nonceData = Data(hexString: nonce)! // see extension below
        let clientDataHash = Data(SHA256.hash(data: nonceData))

        // 4. Attest the key with Apple
        let attestation = try await service.attestKey(keyId, clientDataHash: clientDataHash)

        // 5. Register with the proxy
        try await register(
            proxyBaseURL: proxyBaseURL,
            keyId: keyId,
            attestation: attestation,
            nonce: nonce
        )

        // 6. Persist the key ID
        saveKeyId(keyId)
    }

    // MARK: - Private

    private func fetchChallenge(from baseURL: URL) async throws -> String {
        let url = baseURL.appendingPathComponent("/attest/challenge")
        let (data, _) = try await URLSession.shared.data(from: url)
        let json = try JSONDecoder().decode([String: String].self, from: data)
        guard let nonce = json["nonce"] else {
            throw AttestError.missingNonce
        }
        return nonce
    }

    private func register(
        proxyBaseURL: URL,
        keyId: String,
        attestation: Data,
        nonce: String
    ) async throws {
        let url = proxyBaseURL.appendingPathComponent("/attest/register")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([
            "keyId": keyId,
            "attestation": attestation.base64EncodedString(),
            "nonce": nonce,
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "(no body)"
            throw AttestError.registrationFailed(body)
        }
    }

    // MARK: - Keychain helpers

    func loadKeyId() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
            kSecReturnData as String: true,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func saveKeyId(_ keyId: String) {
        let data = Data(keyId.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
            kSecValueData as String: data,
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
}

enum AttestError: Error {
    case missingNonce
    case registrationFailed(String)
    case assertionFailed(String)
    case serviceUnavailable
}
```

### 1.3 Per-connection assertion

Before every WebSocket connection, fetch a fresh challenge and generate an assertion. The assertion headers are added to the WebSocket upgrade request.

```swift
extension AppAttestManager {
    /// Returns the three headers required by the proxy for each WebSocket connection.
    func assertionHeaders(proxyBaseURL: URL) async throws -> [String: String] {
        guard let keyId = loadKeyId() else {
            throw AttestError.serviceUnavailable
        }

        // 1. Fetch a fresh challenge
        let nonce = try await fetchChallenge(from: proxyBaseURL)

        // 2. Hash the nonce bytes
        let nonceData = Data(hexString: nonce)!
        let clientDataHash = Data(SHA256.hash(data: nonceData))

        // 3. Generate an assertion (signed by Secure Enclave)
        let assertion = try await service.generateAssertion(keyId, clientDataHash: clientDataHash)

        return [
            "X-App-Assert-KeyId": keyId,
            "X-App-Assert-Data": assertion.base64EncodedString(),
            "X-App-Assert-Nonce": nonce,
        ]
    }
}
```

### 1.4 Opening the WebSocket

```swift
func openWebSocket(
    proxyURL: URL,
    attestManager: AppAttestManager,
    proxyBaseURL: URL
) async throws -> URLSessionWebSocketTask {
    // Build upgrade request with assertion headers
    var request = URLRequest(url: proxyURL)
    let headers = try await attestManager.assertionHeaders(proxyBaseURL: proxyBaseURL)
    for (key, value) in headers {
        request.setValue(value, forHTTPHeaderField: key)
    }

    let session = URLSession(configuration: .default)
    let task = session.webSocketTask(with: request)
    task.resume()
    return task
}
```

**URLs:**

- `proxyBaseURL` — the HTTPS base URL, e.g. `https://your-proxy.example.com:6200`
- `proxyURL` — the WebSocket URL, e.g. `wss://your-proxy.example.com:6200`

---

## Part 2: Simulator and Debug Builds

The iOS Simulator has no Secure Enclave, so `DCAppAttestService.shared.isSupported` is `false` there and no assertion can be produced. Earlier versions of this proxy papered over that with a mutual-TLS fallback: a client certificate bundled into debug builds was accepted in place of an assertion.

**That fallback has been removed.** `ALLOW_MTLS_FALLBACK` and `MTLS_CLIENT_CA_PATH` no longer exist, and the proxy aborts at startup if either is still set in your environment.

It was removed because of how it was gated. The condition was `ALLOW_MTLS_FALLBACK && NODE_ENV !== 'production'` — and `NODE_ENV` is unset on a plain `bun start`, which is not `'production'`. A deployment that never set `NODE_ENV` therefore had the fallback available, meaning any client holding a certificate signed by the configured CA could skip attestation entirely. The guard read as a production safeguard and behaved as the opposite.

### What to use instead

Run the Simulator against a proxy configured with a shared secret rather than App Attest:

```bash
# Simulator / local development
AUTH_MODE=shared-secret
PROXY_SHARED_SECRET=<at least 32 bytes>
# App Attest left unconfigured, so REQUIRE_APP_AUTH must stay unset
```

The client sends the secret as an `Authorization: Bearer` header on the upgrade request:

```swift
func makeWebSocketTask(proxyURL: URL, proxyBaseURL: URL) async throws -> URLSessionWebSocketTask {
    var request = URLRequest(url: proxyURL)

#if targetEnvironment(simulator)
    // No Secure Enclave here. Authenticate with the shared secret instead;
    // this build must never ship, so keep the secret out of Release.
    request.setValue("Bearer \(Config.proxySharedSecret)", forHTTPHeaderField: "Authorization")
#else
    // Device build — App Attest assertion headers.
    let attestManager = AppAttestManager()
    let headers = try await attestManager.assertionHeaders(proxyBaseURL: proxyBaseURL)
    for (key, value) in headers {
        request.setValue(value, forHTTPHeaderField: key)
    }
#endif

    let session = URLSession(configuration: .default)
    let task = session.webSocketTask(with: request)
    task.resume()
    return task
}
```

Two consequences worth planning around:

- **A shared secret is a shared secret.** Anyone holding it can connect. Use a different one for development than for anything reachable from the internet, and do not compile it into a Release build.
- **The two modes are independent.** `AUTH_MODE=shared-secret` and App Attest can both be enabled on the same deployment, and pairing them is the recommended posture given the review gap noted at the top of this guide. Shared-secret authentication is checked first, before any App Attest work, so a failed attempt costs nothing.

Testing the real attestation path requires a physical device. There is no way around that, and a fallback that pretends otherwise is a fallback that ships.

---

## Part 3: Utilities

### Hex string ↔ Data

The server returns the nonce as a lowercase hex string. Convert it to `Data` before hashing:

```swift
extension Data {
    init?(hexString: String) {
        let hex = hexString.lowercased()
        guard hex.count % 2 == 0 else { return nil }
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let byteString = hex[index ..< hex.index(index, offsetBy: 2)]
            guard let byte = UInt8(byteString, radix: 16) else { return nil }
            data.append(byte)
            index = hex.index(index, offsetBy: 2)
        }
        self = data
    }
}
```

---

## Part 4: Full App Launch Flow

```swift
@main
struct MudApp: App {
    let attestManager = AppAttestManager()
    let proxyBaseURL = URL(string: "https://your-proxy.example.com:6200")!

    var body: some Scene {
        WindowGroup {
            ContentView()
                .task {
                    #if !targetEnvironment(simulator)
                    try? await attestManager.registerIfNeeded(proxyBaseURL: proxyBaseURL)
                    #endif
                }
        }
    }
}
```

---

## Part 5: Error Handling Reference

| Scenario                                                     | Cause                                                          | Fix                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `registrationFailed("Invalid or expired nonce")`             | Nonce expired (60s TTL) before `POST /attest/register` arrived | Reduce latency; retry with a fresh challenge                |
| HTTP 404 from `/attest/challenge` or `/attest/register`      | App Attest is not configured, so the routes are not registered | Set both `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`      |
| HTTP 429 from `/attest/challenge`                            | More than 30 challenges/minute from one source address         | Request one nonce per connection, not per retry             |
| HTTP 429 from `/attest/register`                             | More than 5 registrations/minute from one source address       | Register once per install; cache the `keyId` in the Keychain |
| `registrationFailed("rpIdHash does not match bundleId")`     | `APPATTEST_BUNDLE_ID` doesn't match app's actual bundle ID     | Verify env var matches `PRODUCT_BUNDLE_IDENTIFIER` in Xcode |
| `DCError.invalidInput` from Apple                            | Device not eligible (too old, or running iOS < 14)             | Check `DCAppAttestService.shared.isSupported`               |
| WebSocket connection rejected (no 101)                       | Assertion headers missing or assertion failed                  | Re-register if keyId lost; check nonce freshness            |
| Previously-working device rejected after a long gap          | Its key passed the 90-day inactivity TTL and was reclaimed     | Re-register; this is expected, not a fault                  |
| Server aborts at startup naming `ALLOW_MTLS_FALLBACK`        | Retired variable still present in the environment              | Remove it; see [Part 2](#part-2-simulator-and-debug-builds) |

---

## Part 6: Server Configuration Reference

Add to your `.env`:

```bash
# These two together are what enable App Attest. There is no separate
# APPATTEST_ENABLED flag, and setting only one aborts startup.
APPATTEST_BUNDLE_ID=com.example.yourapp   # must match exactly
APPATTEST_TEAM_ID=AAABBBCCC1              # 10-char Apple Developer team ID

# Enforce assertions on every upgrade. Requires the two above; setting it
# without them aborts startup rather than rejecting every client.
REQUIRE_APP_AUTH=true

# Recommended: an independent second factor, given the review gap.
AUTH_MODE=shared-secret
PROXY_SHARED_SECRET=<at least 32 bytes>

# Optional. Written atomically; entries unused for 90 days are reclaimed and
# the store is capped at 10,000 keys.
# ATTESTED_KEYS_PATH=./config/attested-keys.json
```

The proxy serves both HTTP endpoints on the same port as WebSockets (default `6200`), **and only when App Attest is configured** — otherwise they 404 like any unknown path:

| Endpoint            | Method | Used by iOS                    | Rate limit | Description                                         |
| ------------------- | ------ | ------------------------------ | ---------- | --------------------------------------------------- |
| `/attest/challenge` | GET    | Registration + each connection | 30/min per source | Returns `{nonce: "hex64chars", expires: timestamp}` |
| `/attest/register`  | POST   | Registration only              | 5/min per source  | Body: `{keyId, attestation: base64, nonce: hex}`    |

The WebSocket upgrade must include headers:

| Header               | Value                                               |
| -------------------- | --------------------------------------------------- |
| `X-App-Assert-KeyId` | The `keyId` string from `generateKey()`             |
| `X-App-Assert-Data`  | Base64-encoded assertion from `generateAssertion()` |
| `X-App-Assert-Nonce` | Hex nonce string from `/attest/challenge`           |
