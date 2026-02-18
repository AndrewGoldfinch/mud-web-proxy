# iOS Client Integration Guide

This guide covers everything needed to connect an iOS app to mud-web-proxy with App Attest authentication enabled (`REQUIRE_APP_AUTH=true`).

## Overview

Two paths depending on build type:

- **Release / TestFlight** — Apple App Attest. The Secure Enclave holds a key pair; Apple cryptographically proves it belongs to your genuine app binary.
- **Simulator / Debug** — Mutual TLS (mTLS). A client certificate bundled into the debug build is verified by the server.

Each WebSocket connection requires a fresh server challenge signed by the device. Registration (generating and attesting the key) happens once per device install and is stored in the iOS Keychain.

---

## Prerequisites

- Xcode project with a valid bundle ID and Apple Developer team
- App Attest capability enabled in your entitlements (`com.apple.developer.devicecheck.appattest-environment` set to `production` or `development`)
- Server running with `REQUIRE_APP_AUTH=true`, `APPATTEST_BUNDLE_ID`, and `APPATTEST_TEAM_ID` set

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

## Part 2: mTLS Fallback (Simulator / Debug Builds)

### 2.1 Generate the client certificate (server-side, one time)

Run this on your dev machine. Keep `ca.key` private — never commit it.

```bash
mkdir -p config/client-ca

# Generate CA key + self-signed cert
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout config/client-ca/ca.key \
  -x509 -days 3650 \
  -subj "/CN=MudApp Debug CA/O=YourOrg" \
  -out config/client-ca/ca.pem

# Generate client key + CSR
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout config/client-ca/client.key \
  -subj "/CN=MudApp Debug Client" \
  -out config/client-ca/client.csr

# Sign the client cert with the CA
openssl x509 -req -days 3650 \
  -in config/client-ca/client.csr \
  -CA config/client-ca/ca.pem \
  -CAkey config/client-ca/ca.key \
  -CAcreateserial \
  -out config/client-ca/client.crt

# Bundle into PKCS#12 (no passphrase for simplicity in debug builds)
openssl pkcs12 -export -passout pass: \
  -inkey config/client-ca/client.key \
  -in config/client-ca/client.crt \
  -out config/client-ca/client.p12
```

Set on the server:
```
MTLS_CLIENT_CA_PATH=./config/client-ca/ca.pem
```

### 2.2 Add the certificate to Xcode

1. Add `client.p12` to the Xcode project (drag into the project navigator).
2. In the file's target membership, include it only in the **Debug** configuration — never Release/TestFlight.
3. Mark it as a resource so it's copied to the app bundle.

### 2.3 Present the client certificate for TLS challenge

```swift
#if targetEnvironment(simulator) || DEBUG

class DebugTLSDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodClientCertificate:
            guard let credential = loadDebugClientCredential() else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            completionHandler(.useCredential, credential)

        case NSURLAuthenticationMethodServerTrust:
            // Accept self-signed server cert in debug (optional — remove if using a real cert)
            if let trust = challenge.protectionSpace.serverTrust {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                completionHandler(.performDefaultHandling, nil)
            }

        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func loadDebugClientCredential() -> URLCredential? {
        guard let url = Bundle.main.url(forResource: "client", withExtension: "p12"),
              let p12Data = try? Data(contentsOf: url)
        else { return nil }

        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: ""] as CFDictionary
        guard SecPKCS12Import(p12Data as CFData, options, &items) == errSecSuccess,
              let itemArray = items as? [[String: Any]],
              let first = itemArray.first,
              let identity = first[kSecImportItemIdentity as String]
        else { return nil }

        return URLCredential(
            identity: identity as! SecIdentity,
            certificates: nil,
            persistence: .forSession
        )
    }
}

// Use this session for all WebSocket connections in debug/simulator
let debugSession = URLSession(
    configuration: .default,
    delegate: DebugTLSDelegate(),
    delegateQueue: nil
)

#endif
```

### 2.4 Combined connection helper

```swift
func makeWebSocketTask(proxyURL: URL, proxyBaseURL: URL) async throws -> URLSessionWebSocketTask {
    var request = URLRequest(url: proxyURL)

#if targetEnvironment(simulator) || DEBUG
    // mTLS path — no assertion headers needed
    let session = URLSession(
        configuration: .default,
        delegate: DebugTLSDelegate(),
        delegateQueue: nil
    )
#else
    // App Attest path — add assertion headers
    let attestManager = AppAttestManager()
    let headers = try await attestManager.assertionHeaders(proxyBaseURL: proxyBaseURL)
    for (key, value) in headers {
        request.setValue(value, forHTTPHeaderField: key)
    }
    let session = URLSession(configuration: .default)
#endif

    let task = session.webSocketTask(with: request)
    task.resume()
    return task
}
```

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

| Scenario | Cause | Fix |
|---|---|---|
| `registrationFailed("Invalid or expired nonce")` | Nonce expired (60s TTL) before `POST /attest/register` arrived | Reduce latency; retry with a fresh challenge |
| `registrationFailed("Server not configured for App Attest")` | `APPATTEST_BUNDLE_ID` or `APPATTEST_TEAM_ID` not set on server | Set env vars on server |
| `registrationFailed("rpIdHash does not match bundleId")` | `APPATTEST_BUNDLE_ID` doesn't match app's actual bundle ID | Verify env var matches `PRODUCT_BUNDLE_IDENTIFIER` in Xcode |
| `DCError.invalidInput` from Apple | Device not eligible (too old, or running iOS < 14) | Check `DCAppAttestService.shared.isSupported` |
| WebSocket connection rejected (no 101) | Assertion headers missing or assertion failed | Re-register if keyId lost; check nonce freshness |
| mTLS: server rejects cert | Wrong CA on server, or cert bundled in wrong target | Verify `MTLS_CLIENT_CA_PATH` points to the correct `ca.pem` |

---

## Part 6: Server Configuration Reference

Add to your `.env`:

```bash
REQUIRE_APP_AUTH=true
APPATTEST_BUNDLE_ID=com.example.yourapp   # must match exactly
APPATTEST_TEAM_ID=AAABBBCCC1             # 10-char Apple Developer team ID
MTLS_CLIENT_CA_PATH=./config/client-ca/ca.pem  # for simulator fallback
```

The proxy serves both HTTP endpoints on the same port as WebSockets (default `6200`):

| Endpoint | Method | Used by iOS | Description |
|---|---|---|---|
| `/attest/challenge` | GET | Registration + each connection | Returns `{nonce: "hex64chars", expires: timestamp}` |
| `/attest/register` | POST | Registration only | Body: `{keyId, attestation: base64, nonce: hex}` |

The WebSocket upgrade must include headers:

| Header | Value |
|---|---|
| `X-App-Assert-KeyId` | The `keyId` string from `generateKey()` |
| `X-App-Assert-Data` | Base64-encoded assertion from `generateAssertion()` |
| `X-App-Assert-Nonce` | Hex nonce string from `/attest/challenge` |
