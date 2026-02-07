# MUD Proxy Server: Implementation Guide for MUDBasher

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

## Choosing your tech stack

You have three realistic options for the proxy server:

**TypeScript/Bun (chosen approach):** The `mud-web-proxy` project (github.com/maldorne/mud-web-proxy) has been migrated to TypeScript (~1160 lines) running on Bun. It already handles WebSocket-to-telnet bridging with MCCP, GMCP, MSDP, MXP, ATCP, and full telnet option negotiation out of the box. It has a comprehensive test suite (12 test files) using Bun's native test framework. The `ws` library handles WebSocket, and `net.Socket` handles raw TCP to the MUD. We'll extend it with session persistence and push notifications.

**Swift (Vapor)** keeps your entire stack in one language. Vapor has built-in WebSocket support via SwiftNIO and first-class APNS integration through the `VaporAPNS` package. You'd write the telnet handling yourself using SwiftNIO's `ClientBootstrap`. Deployment is slightly more involved — you need to compile a Linux binary.

**Go** is fast, deploys as a single static binary, and has gorilla/websocket for WebSockets plus standard `net` for TCP. The krishproxy project (github.com/Untermina/krishproxy) is a minimal Go WebSocket-to-telnet proxy you could build on. APNS would use a library like `sideshow/apns2`.

We went with **TypeScript/Bun** — the existing mud-web-proxy codebase provides a solid, well-tested foundation for the telnet protocol layer, and Bun gives us fast startup, built-in TypeScript support, and a native test runner.

## The session model

This is the core of what makes a proxy different from a simple WebSocket-to-telnet bridge. A bridge creates and destroys telnet connections with each WebSocket connection. A proxy decouples them.

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

Every chunk of data the proxy sends to the client gets a monotonically increasing sequence number. The client tracks the last sequence it processed. On reconnect, the client sends that number, and the proxy knows exactly where to resume. This is how ZNC and IRCCloud handle reconnection — it's proven.

```
Proxy → Client: { seq: 1042, data: <raw bytes base64> }
Proxy → Client: { seq: 1043, data: <raw bytes base64> }
-- disconnect --
Client → Proxy: { resume: "session-id", lastSeq: 1042 }
Proxy → Client: { seq: 1043, data: <raw bytes base64> }  // replay
Proxy → Client: { seq: 1044, data: <raw bytes base64> }  // new
```

### Buffer strategy

The output buffer should be a circular/ring buffer. 50KB is a good default — enough for several minutes of MUD output, small enough that replaying it doesn't flood the client. ZNC uses a line-count-based buffer (default 50 lines, configurable up to 5000). For a MUD, byte-count works better since output isn't line-delimited the same way IRC is.

Drop the oldest data when the buffer fills. Don't let a buffer grow unbounded — a busy MUD channel can produce megabytes overnight.

## Telnet protocol handling

This is where most MUD proxy projects get complicated. The proxy sits between the MUD server and your iOS client, and it needs to handle (or at least pass through) the telnet protocol layer.

### What the proxy must handle itself

**Telnet option negotiation (IAC sequences)** between the proxy and the MUD server. The proxy acts as a telnet client. It should negotiate:
- NAWS (window size) — send a reasonable default like 80x24, or let the iOS client specify dimensions
- TTYPE (terminal type) — send "MUDBasher" or "xterm-256color"
- Charset negotiation — request UTF-8

**MCCP (Mud Client Compression Protocol)** — the proxy should negotiate MCCP2 (telnet option 86) with the MUD server and decompress incoming data before buffering it. Don't pass compressed data to the iOS client. Decompress server-side. The proxy gets the bandwidth savings on the MUD-to-proxy leg, and the proxy-to-client leg uses WSS compression if needed.

**TCP keepalives** on the telnet socket. Set idle time to 60s, interval 30s, count 3. Also send application-level keepalives (a telnet NOP or GMCP ping) every 60 seconds to prevent MUD server idle timeouts.

### What the proxy should pass through transparently

**GMCP data** — pass the raw GMCP subnegotiation payloads through to the iOS client as structured messages over the WebSocket. The client already knows how to parse GMCP. The proxy just needs to extract GMCP subnegotiations from the telnet stream and forward them as a separate message type.

**ANSI escape sequences** — pass through raw. The iOS client renders them.

**MXP** — pass through raw if supported. Let the client handle rendering.

### Wire format between proxy and iOS client

Use a simple JSON-envelope protocol over WebSocket:

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

Binary payloads (MUD output) are base64-encoded to survive JSON transport. The overhead is ~33%, which is negligible for text-based games. If you want tighter encoding, you could use WebSocket binary frames with a minimal header instead of JSON, but JSON is easier to debug.

## Push notifications

The proxy is in the perfect position to trigger push notifications, since it sees all MUD output while the client is disconnected.

### What to alert on

Parse the MUD output stream for patterns that indicate events worth interrupting the user:

- **Tells/pages** — private messages from other players. Pattern: `Soandso tells you` or similar, varies by MUD.
- **Combat initiation** — `Soandso attacks you!` or being engaged in combat.
- **Party/group invites**
- **Death** — your character died.
- **Custom triggers** — let the user define regex patterns in the iOS app that get synced to the proxy.

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

**With TypeScript/Bun**, use the `apn` package or make raw HTTP/2 requests to `api.push.apple.com`.

### Notification types

**Visible notifications** (priority 10) — use for tells, combat, death. These are highly reliable and work even after force-quit.

**Silent notifications** (`content-available: 1`) — use to pre-fetch buffered output before the user opens the app. But they're throttled to maybe 2-4 per hour and won't fire if the user force-quit. Don't rely on them.

**Notification Service Extension** — runs in a separate process for ~30 seconds, even if the app is killed. You can fetch recent MUD output from the proxy's REST API and include it in the notification body. The user sees the actual tell text in their notification without opening the app.

## Deployment options

### Self-hosted VPS (recommended to start)

A $5-6/month VPS handles this easily. The proxy is lightweight — each session is one TCP socket, one WebSocket, and a 50KB buffer.

| Provider | Cheapest tier | Notes |
|---|---|---|
| DigitalOcean | $4/mo (512MB) | Simple, good docs |
| Hetzner | €3.79/mo (2GB) | Best value, EU or US-East |
| Vultr | $5/mo (1GB) | Many regions |
| Linode | $5/mo (1GB) | Owned by Akamai |

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

Good for a managed deployment with auto-TLS. Their free tier supports WebSockets natively and you don't have to deal with certificate renewal. Deploy with `fly launch`, add a `Dockerfile`, and you're live. The main caveat: Fly machines can be stopped when idle if you enable auto-stop. For a MUD proxy that needs to maintain connections, disable `auto_stop_machines`.

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

### Offering it as a hosted service

If you want MUDBasher users to not need their own server, you host the proxy as a service. Each user gets a session endpoint. This is the IRCCloud model. You'd need:

- Multi-tenant session management (sessions keyed by user account)
- Authentication (sign in with Apple, simple JWT)
- Rate limiting and abuse prevention
- A bigger VPS or autoscaling (but even a $20/mo box handles hundreds of concurrent sessions)

This becomes a recurring infrastructure cost you'd need to cover through subscription revenue or include in the app price.

## iOS client-side implementation

### Connecting via WebSocket

Use `URLSessionWebSocketTask` (available since iOS 13) or `NWConnection` with WebSocket options. `URLSessionWebSocketTask` is simpler:

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

### Handling app lifecycle

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

### Registering for push notifications

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

**Authentication between app and proxy.** Don't let arbitrary clients connect to your proxy and use it as an open telnet relay. Options:
- API key baked into the app (simplest, fine for a personal server)
- Sign in with Apple → JWT token → proxy validates
- Per-session tokens generated at connection time

**TLS everywhere.** The proxy must serve WSS (WebSocket over TLS), not plain WS. iOS App Transport Security requires it, and you don't want MUD credentials flying over plaintext. Let's Encrypt handles this for free.

**Don't store MUD passwords on the proxy.** The iOS client sends login credentials through the proxy to the MUD server. The proxy passes them through. It never needs to persist them. If you add auto-reconnect on the proxy side (re-logging into the MUD if the telnet connection drops), you'd need to store credentials, which adds risk.

**Rate limiting.** If you ever open the proxy to multiple users, limit connections per IP, sessions per account, and buffer sizes per session.

## What to build first

1. ~~**Fork mud-web-proxy**~~ — **DONE.** Forked and migrated to TypeScript/Bun with comprehensive test suite
2. **Add session persistence** — decouple WS lifecycle from telnet lifecycle, add the output buffer and sequence numbering
3. **Test with MUDBasher** — connect via WSS, verify MUD interaction works, verify reconnection replays correctly
4. **Add APNS** — implement tell detection and push notifications
5. **Deploy to a VPS** — DigitalOcean or Hetzner, systemd, certbot for TLS
6. **Add a "Proxy" settings screen in MUDBasher** — let users enter their proxy URL or use your hosted one

Step 1 is complete. The critical path is now steps 2-3. Push notifications and hosted deployment are polish. Get session persistence working first — that's the whole point.
