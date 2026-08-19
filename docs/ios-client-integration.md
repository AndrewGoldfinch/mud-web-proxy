# iOS client integration guide

This guide covers what you need to connect an iOS app to
mud-web-proxy with App Attest authentication enabled (`REQUIRE_APP_AUTH=true`).

**Caution:** App Attest is experimental and optional, and it is off by
default. Until you set both `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`, the
proxy doesn't register the `/attest/*` routes at all, and they return 404. If
you aren't shipping an iOS app, you can ignore this guide.

**Caution:** The Apple attestation and assertion verification in the
`src/app-attest.ts` file hasn't had an independent cryptographic review. It is
a from-scratch implementation of Apple's format, and bugs in that kind of code
don't announce themselves: a verifier that is too permissive still accepts
every genuine client, so it looks like it works. Don't rely on App Attest as
your only access control. Pair it with `AUTH_MODE=shared-secret`, which the
proxy checks first and independently.

## Overview

Apple App Attest is the only supported path, and it requires a physical
device: the Secure Enclave holds a key pair, and Apple cryptographically
proves that the key pair belongs to your app binary.

Each WebSocket connection requires a fresh server challenge that the device
signs. Registration—generating and attesting the key—happens once per device
install, and the resulting key ID goes into the iOS Keychain.

The Simulator can't attest, and there is no certificate-based fallback
anymore. For details, see
[Simulator and debug builds](#simulator-and-debug-builds).

## Prerequisites

- An Xcode project with a valid bundle ID and an Apple Developer team.
- The App Attest capability enabled in your entitlements, with
  `com.apple.developer.devicecheck.appattest-environment` set to `production`
  or `development`.
- A server running with both `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`
  set—startup aborts unless you set both—and with `REQUIRE_APP_AUTH=true`
  after you are ready to enforce attestation.
- A physical iOS device. The Simulator can't produce an attestation.

## App Attest for release and TestFlight builds

### Required frameworks

```swift
import CryptoKit
import DeviceCheck
import Foundation
```

### Registration, once per device

Call the following code on first launch, or after a fresh install. Store the
result in the Keychain, and regenerate it only if the stored key is lost.

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

### Per-connection assertion

Before every WebSocket connection, fetch a fresh challenge and generate an
assertion. Add the assertion headers to the WebSocket upgrade request.

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

### Open the WebSocket

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

The preceding code uses two URLs:

- `proxyBaseURL`: the HTTPS base URL, for example,
  `https://your-proxy.example.com:6200`.
- `proxyURL`: the WebSocket URL, for example,
  `wss://your-proxy.example.com:6200`.

## Simulator and debug builds

The iOS Simulator has no Secure Enclave, so
`DCAppAttestService.shared.isSupported` is `false` there and the Simulator
can't produce an assertion. Earlier versions of this proxy covered that gap
with a mutual-TLS fallback: the proxy accepted a client certificate bundled
into debug builds in place of an assertion.

That fallback has been removed. `ALLOW_MTLS_FALLBACK` and
`MTLS_CLIENT_CA_PATH` no longer exist, and the proxy aborts at startup if
either one is still set in your environment.

The fallback was removed because of how it was gated. The condition was `ALLOW_MTLS_FALLBACK && NODE_ENV !== 'production'`—and `NODE_ENV` is unset on a plain `bun start`, which is not `'production'`. A deployment that never set `NODE_ENV` therefore had the fallback available, meaning any client holding a certificate signed by the configured CA could skip attestation entirely. The guard read as a production safeguard and behaved as the opposite.

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

Plan around two consequences:

- **A shared secret is a shared secret.** Anyone who holds it can connect. Use
  a different secret for development than for anything reachable from the
  internet, and don't compile it into a Release build.
- **The two modes are independent.** You can enable both
  `AUTH_MODE=shared-secret` and App Attest on the same deployment, and pairing
  them is the recommended posture given the review gap described earlier in
  this guide. The proxy checks shared-secret authentication first, before any
  App Attest work, so a failed attempt costs nothing.

Testing the real attestation path requires a physical device. There is no way
around that, and a fallback that hides this fact is a fallback that ships to
production.

## Utilities

### Convert a hex string to Data

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

## Full app launch flow

The following code registers the device once, at launch:

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

## Error handling reference

| Scenario                                                 | Cause                                                                                     | Fix                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `registrationFailed("Invalid or expired nonce")`         | The nonce expired after its 60-second lifetime, before `POST /attest/register` arrived    | Reduce latency, then retry with a fresh challenge                        |
| HTTP 404 from `/attest/challenge` or `/attest/register`  | App Attest is not configured, so the routes are not registered                            | Set both `APPATTEST_BUNDLE_ID` and `APPATTEST_TEAM_ID`                   |
| HTTP 429 from `/attest/challenge`                        | More than 30 challenges per minute from one source address                                | Request one nonce per connection, not per retry                          |
| HTTP 429 from `/attest/register`                         | More than 5 registrations per minute from one source address                              | Register once per install, and cache the `keyId` in the Keychain         |
| `registrationFailed("rpIdHash does not match bundleId")` | `APPATTEST_BUNDLE_ID` doesn't match the app's actual bundle ID                            | Verify that the variable matches `PRODUCT_BUNDLE_IDENTIFIER` in Xcode    |
| `DCError.invalidInput` from Apple                        | The device isn't eligible, because it is too old or runs a version of iOS earlier than 14 | Check `DCAppAttestService.shared.isSupported`                            |
| WebSocket connection rejected without a 101 response     | The assertion headers are missing, or the assertion failed                                | Re-register if the `keyId` is lost, and check nonce freshness            |
| Previously working device rejected after a long gap      | Its key passed the 90-day inactivity limit and was reclaimed                              | Re-register. This outcome is expected, not a fault                       |
| Server aborts at startup naming `ALLOW_MTLS_FALLBACK`    | A retired variable is still present in the environment                                    | Remove it. See [Simulator and debug builds](#simulator-and-debug-builds) |

## Server configuration reference

Add the following settings to your `.env` file:

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

The proxy serves both HTTP endpoints on the same port as the WebSocket
listener, `6200` by default, and only when App Attest is configured.
Otherwise they return 404 like any unknown path.

| Endpoint            | Method | Used by iOS                      | Rate limit               | Description                                         |
| ------------------- | ------ | -------------------------------- | ------------------------ | --------------------------------------------------- |
| `/attest/challenge` | GET    | Registration and each connection | 30 per minute per source | Returns `{nonce: "hex64chars", expires: timestamp}` |
| `/attest/register`  | POST   | Registration only                | 5 per minute per source  | Body: `{keyId, attestation: base64, nonce: hex}`    |

The WebSocket upgrade must include the following headers:

| Header               | Value                                               |
| -------------------- | --------------------------------------------------- |
| `X-App-Assert-KeyId` | The `keyId` string from `generateKey()`             |
| `X-App-Assert-Data`  | Base64-encoded assertion from `generateAssertion()` |
| `X-App-Assert-Nonce` | Hex nonce string from `/attest/challenge`           |
