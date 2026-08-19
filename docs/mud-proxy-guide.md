# MUD proxy server implementation guide for MUDBasher

**Note:** This document is superseded, and retained only for context. It
predates the v4 architecture and describes the proxy as it was being designed
for one iOS client. It is _not_ the wire contract. For the contract, which is
derived from the implementation, see [Client protocols](protocols.md). Nothing
here is maintained against current behavior.

## The architecture at a glance

```
┌──────────────┐    WSS/TLS     ┌──────────────────┐    Telnet/TCP    ┌────────────┐
│  MUDBasher   │◄──────────────►│   Proxy Server   │◄────────────────►│ MUD Server │
│  (iOS app)   │                │   (your VPS)     │                  │            │
└──────────────┘                └──────┬───────────┘                  └────────────┘
                                      │
                                      │ APNS (HTTP/2)
                                      ▼
                                ┌──────────────┐
                                │ Apple Push    │
                                │ Notification  │
                                │ Service       │
                                └──────────────┘
```

The proxy maintains a persistent telnet connection to the MUD server. The iOS app connects to the proxy over WebSocket. When the app backgrounds and the WebSocket drops, the proxy keeps the MUD connection alive and buffers output. When the app returns, it reconnects and the proxy replays what was missed.

## Choose your tech stack

You have three realistic options for the proxy server.

**TypeScript and Bun (the chosen approach):** the `mud-web-proxy` project has been migrated to TypeScript, roughly 1,160 lines, running on Bun. It already handles WebSocket-to-telnet bridging with MCCP, GMCP, MSDP, MXP, ATCP, and full telnet option negotiation. It has a test suite of 12 files that uses Bun's native test framework. The `ws` library handles WebSocket, and `net.Socket` handles raw TCP to the MUD. This project extends it with session persistence and push notifications.

**Swift with Vapor** keeps your entire stack in one language. Vapor has built-in WebSocket support through SwiftNIO, and APNS integration through the `VaporAPNS` package. You write the telnet handling yourself, using SwiftNIO's `ClientBootstrap`. Deployment takes more work, because you need to compile a Linux binary.

**Go** deploys as a single static binary, and has `gorilla/websocket` for WebSockets plus the standard `net` package for TCP. The krishproxy project is a minimal Go WebSocket-to-telnet proxy that you could build on. APNS would use a library such as `sideshow/apns2`.

This project uses TypeScript and Bun. The existing mud-web-proxy codebase provides a tested foundation for the telnet protocol layer, and Bun gives fast startup, built-in TypeScript support, and a native test runner.

## The session model

The session model is what makes a proxy different from a plain WebSocket-to-telnet bridge. A bridge creates and destroys a telnet connection with each WebSocket connection. A proxy decouples them.

### Session lifecycle

```
1. iOS app connects to proxy via WSS
2. Proxy creates a Session object:
   - sessionId: UUID
   - authToken: random token returned to client
   - telnetConnection: TCP socket to MUD server
   - outputBuffer: circular buffer (configurable, e.g. 50KB)
   - lastClientSequence: 0
   - clientConnected: true

3. Proxy connects to MUD server via telnet
4. Data flows bidirectionally: WS ↔ Session ↔ Telnet

5. iOS app backgrounds → WebSocket drops
   - Session.clientConnected = false
   - Telnet connection stays alive
   - All incoming MUD data appends to outputBuffer
   - Push notification triggers fire (tells, combat, etc.)

6. iOS app foregrounds → new WebSocket connects
   - Client sends: { "resume": sessionId, "token": authToken, "lastSeq": N }
   - Proxy validates token
   - Proxy replays buffered output from sequence N onward
   - Session.clientConnected = true
   - Normal bidirectional flow resumes
```

### Sequence numbering

Every chunk of data the proxy sends to the client gets a monotonically increasing sequence number. The client tracks the last sequence it processed. On reconnect, the client sends that number, and the proxy resumes from exactly that point. That approach is how ZNC and IRCCloud handle reconnection.

```
Proxy → Client: { seq: 1042, data: <raw bytes base64> }
Proxy → Client: { seq: 1043, data: <raw bytes base64> }
-- disconnect --
Client → Proxy: { resume: "session-id", lastSeq: 1042 }
Proxy → Client: { seq: 1043, data: <raw bytes base64> }  // replay
Proxy → Client: { seq: 1044, data: <raw bytes base64> }  // new
```

### Buffer strategy

The output buffer must be a ring buffer. A 50 KB default is enough for several minutes of MUD output, and small enough that replaying it doesn't flood the client. ZNC uses a line-count-based buffer, 50 lines by default and configurable up to 5,000. For a MUD, a byte count works better, because MUD output isn't line-delimited the way IRC output is.

Drop the oldest data when the buffer fills. Don't let a buffer grow unbounded—a busy MUD channel can produce megabytes overnight.

## Telnet protocol handling

Telnet is where most MUD proxy projects get complicated. The proxy sits between the MUD server and your iOS client, and it needs to handle the telnet protocol layer, or at least pass it through.

### What the proxy must handle itself

**Telnet option negotiation, meaning IAC sequences,** between the proxy and the MUD server. The proxy acts as a telnet client. It negotiates the following options:

- NAWS, the window size: send a default such as 80x24, or let the iOS client specify the dimensions.
- TTYPE, the terminal type: send `MUDBasher` or `xterm-256color`.
- Charset negotiation: request UTF-8.

**MCCP, the Mud Client Compression Protocol**: the proxy negotiates MCCP2, telnet option 86, with the MUD server and decompresses incoming data before buffering it. Don't pass compressed data to the iOS client. Decompress server-side. The proxy gets the bandwidth savings on the MUD-to-proxy leg, and the proxy-to-client leg uses WSS compression if needed.

**TCP keepalives** on the telnet socket. Set the idle time to 60 seconds, the interval to 30 seconds, and the count to 3. Also send application-level keepalives (a telnet NOP or GMCP ping) every 60 seconds to prevent MUD server idle timeouts.

### What the proxy should pass through transparently

**GMCP data**: pass the raw GMCP subnegotiation payloads through to the iOS client as structured messages over the WebSocket. The client already parses GMCP. The proxy needs to extract GMCP subnegotiations from the telnet stream and forward them as a separate message type.

**ANSI escape sequences**: pass them through raw. The iOS client renders them.

**MXP**: pass it through raw if the client supports it, and let the client handle rendering.

### Wire format between proxy and iOS client

Use a JSON-envelope protocol over WebSocket:

```json
// Proxy → Client: MUD output
{ "type": "data", "seq": 1042, "payload": "base64-encoded-bytes" }

// Proxy → Client: GMCP message
{ "type": "gmcp", "seq": 1043, "package": "Char.Vitals", "data": {"hp": 100} }

// Client → Proxy: player input
{ "type": "input", "text": "kill dragon\r\n" }

// Client → Proxy: resume session
{ "type": "resume", "sessionId": "...", "token": "...", "lastSeq": 1042 }

// Client → Proxy: new session
{ "type": "connect", "host": "mud.example.com", "port": 4000, "deviceToken": "apns-token" }

// Proxy → Client: session created
{ "type": "session", "sessionId": "...", "token": "..." }

// Client → Proxy: update window size
{ "type": "naws", "width": 80, "height": 40 }
```

Binary payloads, meaning MUD output, are base64-encoded to survive JSON transport. The overhead is roughly 33%, which is negligible for text-based games. For tighter encoding, you could use WebSocket binary frames with a minimal header instead of JSON, but JSON is easier to debug.

The proxy answers a JSON object that it recognizes but can't accept—an unknown `type`, a missing required field, or a value out of range—with an `invalid_request` error, and never forwards it to the MUD. Ordinary player input that happens to begin with `{` still reaches the MUD unchanged, because the proxy validates only recognized shapes.

```json
// Proxy → Client: rejected control message
{
  "type": "error",
  "code": "invalid_request",
  "field": "height",
  "message": "height must be an integer between 1 and 65535"
}
```

### Legacy connect protocol

Before the typed session protocol existed, clients opened a connection with a bare object carrying a `connect` field. That form is still supported, and frozen: it gains no new fields and no new message types. Write any new client against the typed protocol described earlier in this document.

```json
// Client → Proxy: legacy connect
{ "connect": 1, "host": "mud.example.com", "port": 4000 }

// Client → Proxy: legacy connect to the configured default target
{ "connect": 1 }
```

`host` and `port` are both optional. A bare `{"connect": 1}` means the proxy's configured default target, `TN_HOST` and `TN_PORT`. The default is not privileged: it goes through the same target validation as any other, so under `TARGET_MODE=allowlist` the proxy refuses it unless `TN_HOST` is itself listed.

Both protocols share one policy path, `authorizeConnect`, so the legacy form is subject to the same target validation, connection limits, dial reservation, and DNS-rebinding guard as the typed form. Authentication is enforced at the WebSocket upgrade rather than per message, so it applies to both by construction: under `AUTH_MODE=shared-secret` a legacy client without valid credentials never gets a socket.

**Policy is shared; the data plane deliberately is not.** A legacy connection is a raw telnet bridge, not a session:

| Aspect               | Typed                                          | Legacy                                    |
| -------------------- | ---------------------------------------------- | ----------------------------------------- |
| MUD output           | `{"type":"data","seq":…,"payload":"<base64>"}` | Bare base64, with no envelope             |
| Player input         | `{"type":"input","text":"…"}`                  | Raw bytes, forwarded as sent              |
| On connect           | `{"type":"session","sessionId":…,"token":…}`   | No frame. Telnet data begins flowing      |
| On rejection         | `{"type":"error","code":…}`                    | Base64-encoded plaintext line, then close |
| Buffering and resume | Yes, with `sessionId` and `token`              | None                                      |
| Client disconnect    | The session survives for resume                | The MUD connection is torn down           |

Everything a legacy client receives is base64, rejection messages included. Routing legacy through the session stack instead would hand it typed JSON envelopes that it would print into the player's terminal, and a resumable session that it holds no token for. The connection would then be orphaned until the session timeout, because nothing could reclaim it.

Because a legacy connection has no session to own its capacity, it is counted against `maxPerIP` for the lifetime of the socket and released when the socket closes.

The proxy rejects a second connect on a socket that already has a connection, on both protocols.

## Push notifications

The proxy is well placed to trigger push notifications, because it receives all MUD output while the client is disconnected.

### What to alert on

Parse the MUD output stream for patterns that indicate events worth interrupting the user:

- **Tells and pages**: private messages from other players. The pattern is `Soandso tells you` or something similar, and it varies by MUD.
- **Combat initiation**: `Soandso attacks you!`, or the player being engaged in combat.
- **Party and group invites.**
- **Death**: the player's character died.
- **Custom triggers**: let the user define regular expressions in the iOS app that sync to the proxy.

Store the user's APNS device token in the session. When a trigger fires and `clientConnected == false`, send a push.

### APNS integration

Use token-based authentication (`.p8` key file). This is Apple's recommended approach and doesn't require per-device certificates.

**With Vapor:**

```swift
// In configure.swift
import VaporAPNS

app.apns.configuration = try .init(
    authenticationMethod: .jwt(
        key: .private(filePath: "/path/to/AuthKey.p8"),
        keyIdentifier: "YOUR_KEY_ID",
        teamIdentifier: "YOUR_TEAM_ID"
    ),
    topic: "com.yourcompany.mudbasher",
    environment: .production
)
```

**With TypeScript and Bun**, use the `apn` package, or make raw HTTP/2 requests to `api.push.apple.com`.

### Notification types

**Visible notifications**, priority 10: use these for tells, combat, and death. They are delivered even after a force-quit.

**Silent notifications**, `content-available: 1`: use these to pre-fetch buffered output before the user opens the app. They are throttled to roughly 2-4 per hour, and they don't fire if the user force-quit the app, so don't rely on them.

**Notification Service Extension**: runs in a separate process for roughly 30 seconds, even if the app has stopped. You can fetch recent MUD output from the proxy's REST API and include it in the notification body. The user sees the actual tell text in their notification without opening the app.

## Deployment options

### Self-hosted VPS (recommended to start)

A VPS at $5 to $6 per month is enough. Each session is one TCP socket, one WebSocket, and a 50 KB buffer.

| Provider     | Lowest tier           | Notes                           |
| ------------ | --------------------- | ------------------------------- |
| DigitalOcean | $4 per month, 512 MB  | Simple, with good documentation |
| Hetzner      | €3.79 per month, 2 GB | Low cost, EU or US-East         |
| Vultr        | $5 per month, 1 GB    | Many regions                    |
| Linode       | $5 per month, 1 GB    | Owned by Akamai                 |

**Setup with Bun on Ubuntu:**

```bash
# On your VPS
sudo apt update && sudo apt install -y certbot unzip
# Install Bun runtime
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

git clone https://github.com/maldorne/mud-web-proxy
cd mud-web-proxy && bun install

# Build TypeScript
bun run build

# Get TLS cert
sudo certbot certonly --standalone -d mudproxy.yourdomain.com
ln -s /etc/letsencrypt/live/mudproxy.yourdomain.com/fullchain.pem cert.pem
ln -s /etc/letsencrypt/live/mudproxy.yourdomain.com/privkey.pem privkey.pem

# Run (use systemd for production)
bun start
# Or for development: bun dev
```

### Fly.io

Fly.io suits a managed deployment with automatic TLS. Its free tier supports WebSockets natively, and you don't handle certificate renewal yourself. Deploy with `fly launch` and add a `Dockerfile`. The main caveat is that Fly machines can stop when idle if you enable auto-stop. For a MUD proxy that must maintain connections, disable `auto_stop_machines`.

```toml
# fly.toml
app = "mudbasher-proxy"

[http_service]
  internal_port = 6200
  force_https = true
  auto_stop_machines = false  # critical: keep sessions alive
  auto_start_machines = true
  min_machines_running = 1
```

### Offer it as a hosted service

If you want MUDBasher users not to need their own server, host the proxy as a service. Each user gets a session endpoint, which is the IRCCloud model. You would need the following:

- Multi-tenant session management, with sessions keyed by user account.
- Authentication, such as Sign in with Apple and a JWT.
- Rate limiting and abuse prevention.
- A larger VPS or autoscaling, although even a $20 per month box handles hundreds of concurrent sessions.

This becomes a recurring infrastructure cost you'd need to cover through subscription revenue or include in the app price.

## iOS client-side implementation

### Connect over WebSocket

Use `URLSessionWebSocketTask`, available from iOS 13, or `NWConnection` with WebSocket options. `URLSessionWebSocketTask` is simpler:

```swift
class ProxyConnection {
    private var webSocketTask: URLSessionWebSocketTask?
    private var lastSequence: Int = 0
    private var sessionId: String?
    private var sessionToken: String?

    func connect(to url: URL) {
        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        listen()
    }

    func resume() {
        guard let sid = sessionId, let token = sessionToken else { return }
        let msg = """
        {"type":"resume","sessionId":"\(sid)","token":"\(token)","lastSeq":\(lastSequence)}
        """
        webSocketTask?.send(.string(msg)) { error in
            if let error { print("Resume failed: \(error)") }
        }
    }

    private func listen() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                self?.handleMessage(message)
                self?.listen() // keep listening
            case .failure(let error):
                self?.handleDisconnect(error)
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        // Parse JSON envelope, update lastSequence, dispatch to UI
    }
}
```

### Handle the app lifecycle

```swift
// In your AppDelegate or SceneDelegate
func sceneDidEnterBackground(_ scene: UIScene) {
    // Start background task for graceful handling
    let taskId = UIApplication.shared.beginBackgroundTask {
        // Expiration handler — save state
        self.saveScrollbackLocally()
    }

    // Save current sequence number to UserDefaults
    UserDefaults.standard.set(proxyConnection.lastSequence, forKey: "lastSequence")
    UserDefaults.standard.set(proxyConnection.sessionId, forKey: "sessionId")

    // The WebSocket will die when iOS suspends us. That's fine.
    // The proxy keeps our MUD connection alive.

    UIApplication.shared.endBackgroundTask(taskId)
}

func sceneWillEnterForeground(_ scene: UIScene) {
    // Reconnect WebSocket and resume session
    proxyConnection.connect(to: proxyURL)
    proxyConnection.resume()
}
```

### Register for push notifications

```swift
UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
    guard granted else { return }
    DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
    }
}

func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    let tokenString = token.map { String(format: "%02.2hhx", $0) }.joined()
    // Send tokenString to proxy when establishing session
    proxyConnection.registerDeviceToken(tokenString)
}
```

## Security considerations

**Authentication between app and proxy.** Don't let arbitrary clients connect to your proxy and use it as an open telnet relay. Consider these options:

- An API key baked into the app, which is fine for a personal server.
- Sign in with Apple, which yields a JWT that the proxy validates.
- Per-session tokens generated at connection time.

**TLS everywhere.** The proxy must serve WSS (WebSocket over TLS), not plain WS. iOS App Transport Security requires it, and you don't want MUD credentials traveling in plaintext. Let's Encrypt handles this for free.

**Don't store MUD passwords on the proxy.** The iOS client sends login credentials through the proxy to the MUD server. The proxy passes them through. It never needs to persist them. If you add auto-reconnect on the proxy side (re-logging into the MUD if the telnet connection drops), you'd need to store credentials, which adds risk.

**Rate limiting.** If you ever open the proxy to multiple users, limit connections per IP, sessions per account, and buffer sizes per session.

## What to build first

1. ~~**Fork mud-web-proxy.**~~ Done. Forked and migrated to TypeScript and Bun, with a test suite.
2. **Add session persistence.** Decouple the WebSocket lifecycle from the telnet lifecycle, and add the output buffer and sequence numbering.
3. **Test with MUDBasher.** Connect over WSS, verify that MUD interaction works, and verify that reconnection replays correctly.
4. **Add APNS.** Implement tell detection and push notifications.
5. **Deploy to a VPS.** Use DigitalOcean or Hetzner, with systemd and certbot for TLS.
6. **Add a Proxy settings screen in MUDBasher.** Let users enter their own proxy URL, or use your hosted one.

Step 1 is complete, and steps 2 and 3 are the critical path. Push notifications and hosted deployment are polish. Get session persistence working first, because that is the whole point.
