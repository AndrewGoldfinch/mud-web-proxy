# Product Requirements Document: MUD Proxy Server for MUDBasher

## Product Overview

MUDBasher needs a proxy server that sits between the iOS client and MUD servers. The proxy maintains persistent telnet connections while the mobile app connects via WebSocket. When the app backgrounds, the proxy buffers MUD output and sends push notifications. When the user returns, the app reconnects and replays what was missed.

This solves the core problem of mobile MUD clients: iOS kills network connections when apps background, breaking the continuous session model that MUDs expect.

**Implementation approach:** Fork and extend `mud-web-proxy` (github.com/maldorne/mud-web-proxy), an existing Node.js WebSocket-to-telnet bridge with MCCP, GMCP, MSDP, and MXP support. The existing codebase handles the telnet protocol layer. We'll add session persistence, output buffering, sequence numbering, and APNS integration.

**Target launch:** MVP in 4-6 weeks

## Goals

**Primary:**
- Eliminate session interruption when MUDBasher backgrounds
- Deliver push notifications for tells, combat, and other critical events
- Replay missed content seamlessly when the app returns

**Secondary:**
- Support multiple MUD servers per user
- Enable custom notification triggers
- Provide a hosted option so users don't need their own VPS

**Non-goals (v1):**
- Multi-user hosted service with accounts (build single-user first)
- Auto-reconnect on telnet connection drops (pass failures to client)
- Client-side MUD password storage on proxy
- Support for non-telnet protocols (SSH, SSL)

## Existing Codebase: mud-web-proxy

The `mud-web-proxy` project provides our foundation. Here's what it already handles:

**Already implemented:**
- WebSocket server using `ws` library
- Telnet client using `net.Socket`
- MCCP2 decompression (telnet option 86)
- GMCP/MSDP/MXP protocol parsing
- ANSI escape sequence pass-through
- Basic telnet option negotiation (NAWS, TTYPE, charset)
- Configurable host/port connection
- TLS/WSS support

**Architecture:**
- ~400 lines of JavaScript
- Single file (`wsproxy.js`)
- Creates new telnet connection per WebSocket connection
- No session persistence - connection dies with WebSocket
- No buffering or replay capability
- No push notifications

**What we need to add:**
- Session management layer that decouples WebSocket from telnet
- Circular output buffer with sequence numbering
- Session resume logic
- APNS integration for push notifications
- Pattern matching for notification triggers
- Authentication tokens
- Session cleanup/timeout logic

### Codebase Organization

**Current structure (mud-web-proxy):**
```
mud-web-proxy/
├── wsproxy.js          # Main server file (~400 lines)
├── package.json
├── cert.pem           # TLS certificate
├── privkey.pem        # TLS private key
└── README.md
```

**Target structure (with our additions):**
```
mudbasher-proxy/       # Forked repo
├── src/
│   ├── server.js           # Main entry point (refactored wsproxy.js)
│   ├── session.js          # Session class - manages telnet + buffer
│   ├── session-manager.js  # SessionManager - stores active sessions
│   ├── circular-buffer.js  # CircularBuffer - output buffering
│   ├── notification-manager.js  # APNS integration
│   ├── trigger-matcher.js  # Pattern matching for notifications
│   └── telnet-handler.js   # Existing protocol code (extracted)
├── config/
│   ├── production.json     # Production config
│   ├── development.json    # Dev config
│   └── apns-key.p8        # APNS auth key (not in git)
├── tests/
│   ├── session.test.js
│   ├── buffer.test.js
│   └── triggers.test.js
├── package.json
└── README.md
```

**Where existing mud-web-proxy code goes:**
- Telnet protocol negotiation → `telnet-handler.js`
- MCCP/GMCP/MSDP parsing → `telnet-handler.js`
- WebSocket server setup → `server.js`
- Main event loop → Refactored into `server.js` + `session.js`

## User Personas

**Primary: Power MUD player**
- Plays 3-10 hours per week across multiple sessions
- Wants to stay connected during commutes, meetings, bathroom breaks
- Needs notifications when groupmates call for help
- Comfortable running their own VPS or paying $5/month for hosting

**Secondary: Casual player returning to MUDs**
- Plays 1-3 hours per week
- Less technical, wants a hosted solution
- Primarily uses one MUD
- Needs basic tell notifications

## Functional Requirements

### Session Management

**FR-1: Session lifecycle**
- Proxy creates a Session object when iOS client connects via WSS
- Session contains: UUID, auth token, telnet socket, output buffer, sequence counter, connection state
- Telnet connection persists independent of WebSocket lifecycle
- Session remains active for 24 hours after last client connection
- Session terminates if telnet connection drops

**FR-2: Resumable connections**
- Client sends resume message with sessionId, authToken, and lastSequence
- Proxy validates token and replays buffered output from lastSequence onward
- Client can resume session from multiple iOS devices (phone, iPad)
- Invalid resume attempts return error and require new connection

**FR-3: Buffer management**
- Circular buffer stores last 50KB of MUD output per session
- Each output chunk tagged with monotonically increasing sequence number
- Buffer drops oldest data when full
- Buffer persists in memory only (no disk writes)

### Telnet Protocol Handling

**FR-4: Protocol negotiation**
- Proxy negotiates NAWS (window size), TTYPE (terminal type), and charset with MUD server
- Sends "MUDBasher" as terminal type or "xterm-256color" if MUD requires it
- Requests UTF-8 encoding
- Handles standard telnet IAC sequences

**FR-5: MCCP compression**
- Negotiates MCCP2 (telnet option 86) with MUD server
- Decompresses incoming data before buffering
- Does not pass compressed data to iOS client

**FR-6: Protocol pass-through**
- GMCP data extracted from telnet stream and forwarded as structured JSON
- ANSI escape sequences passed through raw
- MXP markup passed through raw if present
- No modification of game output content

**FR-7: Connection keepalive**
- TCP keepalive on telnet socket: 60s idle, 30s interval, 3 probes
- Application-level keepalive every 60 seconds (NOP or GMCP ping)
- Prevents MUD server idle disconnects

### WebSocket Protocol

**FR-8: Message types**

Client → Proxy:
- `connect`: Create new session with MUD host, port, deviceToken
- `resume`: Resume existing session with sessionId, token, lastSeq
- `input`: Player command to send to MUD
- `naws`: Update window dimensions

Proxy → Client:
- `session`: Session created, returns sessionId and authToken
- `data`: MUD output with sequence number and base64-encoded payload
- `gmcp`: GMCP message with sequence, package name, and parsed JSON data
- `error`: Connection error, invalid resume, etc.

**FR-9: Sequence numbering**
- Every output message includes monotonically increasing sequence number
- Client tracks last processed sequence in UserDefaults
- Sequence counter persists for session lifetime
- Gaps in sequence numbers indicate missed data (impossible if buffer intact)

### Push Notifications

**FR-10: Trigger detection**
- Parse MUD output for patterns while `clientConnected == false`
- Built-in patterns: tells/pages, combat initiation, death, party invites
- Custom regex patterns synced from iOS client per session
- Pattern matching runs on decompressed, pre-buffered output

**FR-11: APNS integration**
- Store APNS device token per session (sent during connect/resume)
- Use token-based authentication (.p8 key file)
- Send notifications to production APNS endpoint
- Notification payload includes: alert text, badge count, session context

**FR-12: Notification types**
- Tell/page: "Soandso tells you: <message preview>"
- Combat: "You are under attack!"
- Death: "You have died"
- Custom: User-defined trigger label + matched text

**FR-13: Notification rate limiting**
- Max 1 notification per trigger type per minute
- Max 10 notifications total per hour per session
- Combat notifications limited to first attack only
- Subsequent matching patterns suppressed until different trigger fires

### Security

**FR-14: TLS requirements**
- All WebSocket connections must use WSS (TLS 1.2+)
- No plain WS support
- Certificate management via Let's Encrypt or equivalent

**FR-15: Session authentication**
- Auth token generated at session creation (crypto-random 32 bytes, hex-encoded)
- Token required for resume operations
- Token expires when session terminates
- No password storage on proxy (credentials pass through to MUD)

**FR-16: Connection limits**
- Max 5 sessions per device token
- Max 10 concurrent WebSocket connections per IP
- Terminate oldest session when limit exceeded

## Technical Requirements

### Infrastructure

**TR-1: Deployment target**
- VPS with 512MB RAM, 1 CPU core, 10GB disk
- Ubuntu 22.04 or 24.04 LTS
- Node.js 18+ or Swift/Vapor on Linux
- Systemd for process management

**TR-2: Networking**
- Open port 443 for WSS (or 6200 with reverse proxy)
- Outbound TCP to arbitrary MUD servers (ports 23, 4000, 6969, etc.)
- HTTP/2 connection to api.push.apple.com
- Domain with DNS A record pointing to VPS IP

**TR-3: TLS certificates**
- Automated renewal via certbot
- Certificate files readable by proxy process user
- SNI support for multiple domains (future multi-tenant)

### Performance

**TR-4: Session capacity**
- 50 concurrent sessions minimum on 512MB VPS
- 200 concurrent sessions target on 2GB VPS
- Each session consumes: 50KB buffer + telnet socket + WebSocket overhead
- No memory leaks over 7-day continuous operation

**TR-5: Latency**
- WebSocket message round-trip: <100ms median, <500ms p99
- Telnet-to-WebSocket relay: <50ms processing time
- Buffer replay on resume: <2 seconds for full 50KB buffer

**TR-6: Throughput**
- Handle 10KB/second sustained MUD output per session
- Support burst output of 100KB (large room descriptions, spell effects)
- WebSocket send queue doesn't block telnet receive

### Reliability

**TR-7: Failure handling**
- Telnet connection drop: send error to client, terminate session after 30 seconds
- WebSocket drop: maintain telnet connection, buffer output, client can resume
- Proxy crash: all sessions lost, clients must reconnect to new sessions
- MUD server unreachable: return error immediately, don't create session

**TR-8: Logging**
- Connection events (session created, resumed, terminated)
- Errors (telnet failures, invalid resumes, APNS failures)
- Statistics (sessions active, buffer fill rates, notification counts)
- No logging of MUD output content (privacy)

**TR-9: Monitoring**
- Health check endpoint returns 200 if process running
- Metrics endpoint (optional): active sessions, total data transferred, uptime

## Architectural Changes to mud-web-proxy

### Current Architecture (mud-web-proxy baseline)

```javascript
// Simplified current flow
websocket.on('connection', (ws) => {
  const telnet = net.createConnection(mudHost, mudPort);
  
  // Bidirectional pipe
  ws.on('message', data => telnet.write(data));
  telnet.on('data', data => ws.send(processOutput(data)));
  
  // Coupled lifecycle
  ws.on('close', () => telnet.end());
  telnet.on('close', () => ws.close());
});
```

**Problem:** WebSocket and telnet lifecycles are tightly coupled. When WebSocket closes, telnet closes.

### Target Architecture (with session persistence)

```javascript
// Session-based architecture
const sessions = new Map(); // sessionId -> Session

websocket.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const parsed = JSON.parse(msg);
    
    if (parsed.type === 'connect') {
      // Create new session
      const session = createSession(parsed.host, parsed.port);
      sessions.set(session.id, session);
      
      // Attach WebSocket to session
      session.attachClient(ws);
      
      ws.send(JSON.stringify({
        type: 'session',
        sessionId: session.id,
        token: session.authToken
      }));
      
    } else if (parsed.type === 'resume') {
      // Resume existing session
      const session = sessions.get(parsed.sessionId);
      if (validateToken(session, parsed.token)) {
        session.attachClient(ws);
        session.replayBuffer(parsed.lastSeq);
      } else {
        ws.send(JSON.stringify({ type: 'error', code: 'invalid_resume' }));
      }
      
    } else if (parsed.type === 'input') {
      // Forward to session's telnet connection
      const session = findSessionByWebSocket(ws);
      session.sendToMud(parsed.text);
    }
  });
  
  ws.on('close', () => {
    const session = findSessionByWebSocket(ws);
    if (session) {
      session.detachClient(ws);
      // Session continues, telnet stays alive
    }
  });
});

// Session class manages telnet independently
class Session {
  constructor(host, port) {
    this.telnet = net.createConnection(host, port);
    this.buffer = new CircularBuffer(50 * 1024);
    this.sequence = 0;
    this.clients = new Set(); // Multiple WebSockets possible
    
    this.telnet.on('data', (data) => {
      const processed = this.processOutput(data);
      this.bufferOutput(processed);
      
      if (this.clients.size === 0) {
        // Client disconnected, check for notification triggers
        this.checkTriggers(processed);
      } else {
        // Client connected, send immediately
        this.broadcast(processed);
      }
    });
  }
  
  attachClient(ws) {
    this.clients.add(ws);
    this.clientConnected = true;
  }
  
  detachClient(ws) {
    this.clients.delete(ws);
    this.clientConnected = (this.clients.size > 0);
  }
}
```

### Key Changes Required

**1. Session Manager**
- Replace per-connection telnet sockets with persistent Session objects
- Store sessions in Map with UUID keys
- Implement session lifecycle (create, attach, detach, cleanup)

**2. Message Protocol**
- Wrap all WebSocket messages in JSON envelope with `type` field
- Add `sessionId` and `authToken` to connection flow
- Add `seq` field to all proxy→client messages

**3. Buffer Management**
- Implement CircularBuffer class with fixed size
- Tag each buffer chunk with sequence number
- Support replay from arbitrary sequence number

**4. Client Attachment**
- Allow multiple WebSockets per session (iPad + iPhone)
- Broadcast to all attached clients when data arrives
- Track connection state separately from telnet state

**5. Telnet Lifecycle**
- Telnet socket persists independent of WebSocket
- Session cleanup on timeout (24 hours) not on WebSocket close
- Graceful telnet shutdown when session explicitly terminated

## Data Models

### Session Object

```
{
  sessionId: string (UUID)
  authToken: string (64-char hex)
  createdAt: timestamp
  lastClientConnection: timestamp
  
  mudHost: string
  mudPort: number
  
  telnetSocket: Socket
  telnetConnected: boolean
  
  webSocketClients: WebSocket[] (multiple devices possible)
  clientConnected: boolean
  
  outputBuffer: CircularBuffer<BufferChunk>
  sequenceCounter: number (monotonic)
  
  deviceToken: string (APNS)
  notificationTriggers: Trigger[]
  
  windowWidth: number (default 80)
  windowHeight: number (default 24)
}
```

### BufferChunk

```
{
  sequence: number
  timestamp: timestamp
  data: Buffer (raw bytes from MUD)
  type: "data" | "gmcp"
  gmcpPackage?: string
  gmcpData?: object
}
```

### Trigger

```
{
  id: string
  type: "tell" | "combat" | "death" | "custom"
  pattern: regex string
  enabled: boolean
  label?: string (for custom triggers)
}
```

## API Specification

### WebSocket Message Formats

**Client → Proxy: Connect**
```json
{
  "type": "connect",
  "host": "aardmud.org",
  "port": 4000,
  "deviceToken": "a1b2c3d4...",
  "apiKey": "..."
}
```

**Proxy → Client: Session Created**
```json
{
  "type": "session",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "token": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

**Client → Proxy: Resume**
```json
{
  "type": "resume",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "token": "9f86d081...",
  "lastSeq": 1042
}
```

**Proxy → Client: Data**
```json
{
  "type": "data",
  "seq": 1043,
  "payload": "VGhlIGRyYWdvbiByb2FycyE="
}
```

**Proxy → Client: GMCP**
```json
{
  "type": "gmcp",
  "seq": 1044,
  "package": "Char.Vitals",
  "data": {
    "hp": 850,
    "maxhp": 1200,
    "mp": 430,
    "maxmp": 500
  }
}
```

**Client → Proxy: Input**
```json
{
  "type": "input",
  "text": "kill dragon\r\n"
}
```

**Client → Proxy: Window Size**
```json
{
  "type": "naws",
  "width": 80,
  "height": 40
}
```

**Proxy → Client: Error**
```json
{
  "type": "error",
  "code": "invalid_resume",
  "message": "Session not found or token invalid"
}
```

## Implementation Phases

### Phase 1: Fork and Baseline (Week 1)
- Fork mud-web-proxy repository
- Set up local development environment
- Deploy unmodified mud-web-proxy to test VPS
- Configure TLS with Let's Encrypt
- Test basic WebSocket-to-telnet bridging with MUDBasher
- Document existing codebase architecture

**Acceptance criteria:**
- Can connect from MUDBasher to Aardwolf via unmodified proxy
- Commands sent through proxy reach MUD
- MUD output appears in MUDBasher
- ANSI colors render correctly
- GMCP data flows through correctly

### Phase 2: Session Persistence Layer (Week 2-3)
- Create SessionManager class to store active sessions
- Decouple telnet socket lifecycle from WebSocket lifecycle
- Implement session creation with UUID and auth tokens
- Add circular buffer (50KB) with sequence numbering
- Modify WebSocket message format to include sequence numbers
- Track client connection state separately from telnet state
- Implement session resume logic with token validation

**Code changes:**
- Refactor `wsproxy.js` to extract session management
- Add `SessionManager` class with Map of sessionId → Session
- Add `CircularBuffer` class for output buffering
- Modify MUD output handler to buffer data with sequence numbers
- Add resume message handler

**Acceptance criteria:**
- WebSocket disconnect doesn't terminate telnet connection
- MUD output buffers while WebSocket disconnected
- Can resume session with valid sessionId and authToken
- Buffer replays from lastSeq onward
- Sequence numbers increment correctly
- Buffer wraps when full, oldest data dropped
- Invalid resume attempts return error

### Phase 3: Push Notifications (Week 3-4)
- Install `apn` package for APNS integration
- Add device token storage to Session object
- Implement pattern matching for notification triggers
- Add built-in patterns: tells, combat, death, party invites
- Add notification rate limiting (1/min per type, 10/hour total)
- Hook pattern matcher into existing output buffer flow
- Send APNS notifications when clientConnected == false

**Code changes:**
- Add `NotificationManager` class with APNS client
- Add `TriggerMatcher` class with regex patterns
- Hook matcher into MUD output processing before buffering
- Store device token from connect/resume messages
- Implement rate limiting with timestamp tracking

**Acceptance criteria:**
- Notification appears when another player sends tell
- Notification includes sender name and message preview
- Notification only fires when WebSocket disconnected
- Rate limiting prevents notification spam
- APNS errors logged but don't crash proxy
- Can test notifications with sandbox APNS

### Phase 4: Production Hardening (Week 4-5)
- Deploy to DigitalOcean/Hetzner VPS ($5/month tier)
- Configure systemd service for auto-restart
- Set up pm2 for process management and monitoring
- Configure Let's Encrypt with auto-renewal
- Add session cleanup (terminate after 24 hours inactive)
- Add connection limits (5 sessions per device, 10 per IP)
- Implement proper logging (winston or bunyan)
- Add health check endpoint

**Infrastructure setup:**
```bash
# On VPS
apt update && apt install -y nodejs npm certbot
git clone your-fork-of-mud-web-proxy
cd mud-web-proxy && npm install

# Production dependencies
npm install apn winston --save

# TLS cert
certbot certonly --standalone -d mudproxy.yourdomain.com

# Process management
npm install -g pm2
pm2 start wsproxy.js --name mudbasher-proxy
pm2 startup
pm2 save
```

**Acceptance criteria:**
- Proxy runs continuously for 7 days without manual restart
- Auto-restarts on crash (systemd or pm2)
- TLS certificates auto-renew
- Logs capture errors without sensitive data (no MUD passwords)
- Health check endpoint returns 200
- Sessions auto-cleanup after 24 hours
- Connection limits enforced

### Phase 5: iOS Client Integration (Week 5-6)
- Add proxy settings screen in MUDBasher
- Implement ProxyConnection class with URLSessionWebSocketTask
- Handle app lifecycle (background/foreground)
- Register for push notifications
- Store session credentials in UserDefaults
- Update connection flow to support proxy vs. direct modes

**MUDBasher code changes:**
- Add ProxyConnection class (replaces direct TelnetConnection)
- Add settings UI for proxy URL and API key
- Modify ConnectionManager to choose proxy or direct mode
- Persist sessionId, authToken, lastSequence
- Handle resume on app foreground

**Acceptance criteria:**
- User can enter proxy URL in settings
- MUDBasher connects via proxy instead of direct telnet
- Backgrounding preserves session
- Notifications tap opens MUDBasher to correct session
- Can toggle between proxy and direct mode
- Connection status shows "via proxy" in UI

### iOS Client Changes Required

**New settings:**
```swift
struct ProxySettings {
    var enabled: Bool = false
    var url: URL? // wss://mudproxy.example.com:6200
    var apiKey: String? // Optional authentication
}
```

**Connection flow:**
```swift
// Before (direct telnet):
let connection = TelnetConnection(host: "aardmud.org", port: 4000)
connection.connect()

// After (via proxy):
let proxyConnection = ProxyConnection(proxyURL: settings.proxyURL)
proxyConnection.connect(to: "aardmud.org", port: 4000)

// Or resume existing:
if let sessionId = UserDefaults.standard.string(forKey: "sessionId"),
   let authToken = UserDefaults.standard.string(forKey: "authToken"),
   let lastSeq = UserDefaults.standard.integer(forKey: "lastSequence") {
    proxyConnection.resume(sessionId: sessionId, token: authToken, lastSeq: lastSeq)
}
```

**Message handling:**
```swift
class ProxyConnection {
    private var webSocketTask: URLSessionWebSocketTask?
    private var lastSequence: Int = 0
    private var sessionId: String?
    private var sessionToken: String?
    
    func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message else { return }
        let data = text.data(using: .utf8)!
        let msg = try? JSONDecoder().decode(ProxyMessage.self, from: data)
        
        switch msg?.type {
        case "session":
            // Store credentials
            self.sessionId = msg.sessionId
            self.sessionToken = msg.token
            UserDefaults.standard.set(sessionId, forKey: "sessionId")
            UserDefaults.standard.set(sessionToken, forKey: "authToken")
            
        case "data":
            // Decode base64 payload
            let rawData = Data(base64Encoded: msg.payload)!
            self.lastSequence = msg.seq
            UserDefaults.standard.set(lastSequence, forKey: "lastSequence")
            delegate?.didReceiveData(rawData)
            
        case "gmcp":
            // Handle GMCP message
            delegate?.didReceiveGMCP(package: msg.package, data: msg.data)
            
        case "error":
            // Handle error - possibly force new connection
            if msg.code == "invalid_resume" {
                self.sessionId = nil
                self.connect(to: lastMudHost, port: lastMudPort)
            }
        }
    }
}
```

**Lifecycle handling:**
```swift
class SceneDelegate {
    func sceneDidEnterBackground(_ scene: UIScene) {
        // Save current state
        UserDefaults.standard.set(proxyConnection.sessionId, forKey: "sessionId")
        UserDefaults.standard.set(proxyConnection.authToken, forKey: "authToken")
        UserDefaults.standard.set(proxyConnection.lastSequence, forKey: "lastSequence")
        
        // WebSocket will die, that's expected
        // Proxy keeps telnet connection alive
    }
    
    func sceneWillEnterForeground(_ scene: UIScene) {
        // Reconnect WebSocket
        let proxyURL = URL(string: "wss://mudproxy.example.com:6200")!
        proxyConnection.connect(to: proxyURL)
        
        // Resume session if we have one
        if let sessionId = UserDefaults.standard.string(forKey: "sessionId"),
           let authToken = UserDefaults.standard.string(forKey: "authToken") {
            let lastSeq = UserDefaults.standard.integer(forKey: "lastSequence")
            proxyConnection.resume(sessionId: sessionId, token: authToken, lastSeq: lastSeq)
        }
    }
}
```

**Push notification handling:**
```swift
func application(_ application: UIApplication, 
                didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    
    // Extract session info from notification
    if let sessionId = userInfo["sessionId"] as? String {
        // Restore this session when app opens
        UserDefaults.standard.set(sessionId, forKey: "pendingSessionId")
    }
    
    completionHandler(.newData)
}

func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    // Check if launched from notification
    if let pendingSession = UserDefaults.standard.string(forKey: "pendingSessionId") {
        // Resume this specific session
        proxyConnection.resume(sessionId: pendingSession, ...)
        UserDefaults.standard.removeObject(forKey: "pendingSessionId")
    }
}
```

### Phase 6: Polish and Advanced Features (Week 6+)
- Add custom trigger management UI in MUDBasher
- Sync custom triggers from iOS app to proxy
- Add session statistics endpoint (active sessions, uptime, data transferred)
- Implement graceful shutdown (close sessions, notify clients)
- Add configurable buffer size per session
- Improve error messages for common failure cases
- Add metrics for monitoring (Prometheus endpoint optional)

**Nice-to-haves:**
- Web-based admin panel to view active sessions
- Logging aggregation to external service (Papertrail, Loggly)
- Multiple APNS environments (dev/production) based on config
- Docker container for easier deployment

## Testing Strategy

### Unit Tests

**Session Management:**
- Session creation assigns unique ID and auth token
- Session.attachClient() adds WebSocket to clients set
- Session.detachClient() removes WebSocket without terminating telnet
- Session cleanup timer fires after 24 hours of inactivity

**Buffer Management:**
- CircularBuffer wraps correctly when reaching capacity
- Sequence numbers increment monotonically
- Buffer.replay() returns chunks from specified sequence onward
- Buffer.replay() handles gaps gracefully (returns what exists)

**Notification Triggers:**
- Tell pattern matches various MUD formats
- Combat pattern detects attack initiation
- Rate limiting prevents duplicate notifications
- Triggers only fire when clientConnected == false

### Integration Tests

**Session Lifecycle:**
1. Connect via WebSocket, create session, verify telnet connects to MUD
2. Disconnect WebSocket, verify telnet stays alive
3. Send MUD output, verify it buffers with sequence numbers
4. Reconnect with valid resume, verify buffer replays
5. Reconnect with invalid token, verify error response

**Protocol Handling:**
1. Send GMCP from MUD, verify it arrives as structured message
2. Send ANSI color codes, verify they pass through unchanged
3. Send player input via WebSocket, verify it reaches MUD
4. Negotiate NAWS, verify MUD receives window size

**Push Notifications:**
1. Disconnect client, send tell from another player, verify APNS fires
2. Send tell while connected, verify no APNS
3. Send multiple tells rapidly, verify rate limiting works
4. Verify APNS payload includes sender and message preview

### Manual Testing Checklist

**Basic functionality:**
- [ ] Connect to Aardwolf, login, send commands
- [ ] Background MUDBasher iOS app
- [ ] Send tell to test character from another character
- [ ] Verify push notification arrives on iOS
- [ ] Foreground app, verify missed content appears
- [ ] Logout, verify session terminates

**Edge cases:**
- [ ] Connect, immediately background, verify buffer starts
- [ ] Background for >24 hours, verify session cleanup
- [ ] Connect from iPhone and iPad simultaneously to same session
- [ ] Kill proxy process, restart, verify all sessions lost
- [ ] Telnet connection drops, verify error sent to client
- [ ] Send 100KB of rapid MUD output, verify no data loss

**MUD compatibility:**
- [ ] Test with Aardwolf (GMCP, MCCP, ANSI colors)
- [ ] Test with ROM-based MUD (basic telnet)
- [ ] Test with Discworld (MXP support)
- [ ] Test with IRE MUD (heavy GMCP usage)
- [ ] Test with raw telnet to port 23 server

## Success Metrics

**Technical:**
- 99% session uptime (excluding planned maintenance)
- <1% connection resume failures
- <5 second buffer replay time
- <100ms median WebSocket latency

**User:**
- 80% of sessions resume successfully after backgrounding
- 90% of tell notifications delivered within 5 seconds
- <5% notification false-positive rate
- Zero complaints about lost MUD output

**Infrastructure:**
- $6/month hosting cost for 50 concurrent sessions
- <200MB RAM usage per 10 sessions
- 7+ day uptime between restarts

## Risks and Mitigations

**Risk: iOS WebSocket connection unreliable**
- Mitigation: Implement exponential backoff reconnection
- Mitigation: Persist session credentials in UserDefaults for resume

**Risk: MUD servers block proxy IP**
- Mitigation: Document proxy use with MUD admins
- Mitigation: Allow users to run own proxy instances
- Mitigation: Rotate IP or use multiple VPS regions

**Risk: Buffer size insufficient for long disconnections**
- Mitigation: Make buffer size configurable per session
- Mitigation: Warn user in UI if buffer fills
- Mitigation: Store overflow to disk (opt-in, future)

**Risk: APNS delivery failures**
- Mitigation: Log APNS errors with telemetry
- Mitigation: Retry failed sends with exponential backoff
- Mitigation: Gracefully degrade if APNS unavailable

**Risk: Telnet protocol edge cases**
- Mitigation: Test with 5+ different MUD servers
- Mitigation: Log unhandled IAC sequences
- Mitigation: Provide "raw mode" bypass for debugging

## Configuration

### Environment Variables

```bash
# Server
PORT=6200                          # WebSocket server port
NODE_ENV=production               # production or development

# TLS
TLS_CERT=/etc/letsencrypt/live/domain/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/domain/privkey.pem

# APNS
APNS_KEY_PATH=/path/to/AuthKey.p8
APNS_KEY_ID=ABC123XYZ              # 10-character key identifier
APNS_TEAM_ID=DEF456UVW             # 10-character team identifier
APNS_TOPIC=com.yourcompany.mudbasher
APNS_ENVIRONMENT=production        # production or sandbox

# Session Management
SESSION_TIMEOUT_HOURS=24           # Auto-cleanup inactive sessions
MAX_SESSIONS_PER_DEVICE=5          # Limit per device token
MAX_CONNECTIONS_PER_IP=10          # Rate limiting

# Buffer
BUFFER_SIZE_KB=50                  # Circular buffer size per session
MAX_REPLAY_CHUNKS=1000            # Limit replay to prevent floods

# Logging
LOG_LEVEL=info                     # error, warn, info, debug
LOG_FILE=/var/log/mudbasher-proxy.log
```

### Configuration Files

**config/production.json:**
```json
{
  "server": {
    "port": 6200,
    "tls": {
      "enabled": true,
      "cert": "/etc/letsencrypt/live/mudproxy.example.com/fullchain.pem",
      "key": "/etc/letsencrypt/live/mudproxy.example.com/privkey.pem"
    }
  },
  "apns": {
    "keyPath": "/etc/mudbasher-proxy/AuthKey.p8",
    "keyId": "ABC123XYZ",
    "teamId": "DEF456UVW",
    "topic": "com.yourcompany.mudbasher",
    "environment": "production"
  },
  "sessions": {
    "timeoutHours": 24,
    "maxPerDevice": 5,
    "maxPerIP": 10
  },
  "buffer": {
    "sizeKB": 50,
    "maxReplayChunks": 1000
  },
  "triggers": {
    "rateLimit": {
      "perTypePerMinute": 1,
      "totalPerHour": 10
    }
  },
  "logging": {
    "level": "info",
    "file": "/var/log/mudbasher-proxy.log"
  }
}
```

**config/development.json:**
```json
{
  "server": {
    "port": 6200,
    "tls": {
      "enabled": false
    }
  },
  "apns": {
    "environment": "sandbox"
  },
  "logging": {
    "level": "debug",
    "file": "./logs/dev.log"
  }
}
```

### Command Line Usage

```bash
# Start with default config
node server.js

# Start with specific config file
node server.js --config config/production.json

# Override specific settings
node server.js --port 8080 --buffer-size 100

# Enable debug logging
node server.js --log-level debug
```

## Open Questions

**Q: Should proxy support auto-reconnect to MUD if telnet drops?**
A: Not in v1. Pass failure to client, let user manually reconnect. Auto-reconnect requires storing MUD credentials on proxy, which increases security risk.

**Q: How long should sessions persist without client connection?**
A: 24 hours. After that, terminate session and close telnet connection. User must create new session on next connect.

**Q: Should buffer replay be compressed?**
A: No. WSS has built-in compression at transport layer. Additional compression adds CPU overhead with minimal bandwidth benefit for text content.

**Q: Support for multiple concurrent MUD connections per user?**
A: Yes, each MUD connection is a separate session with unique sessionId. Client tracks which session IDs correspond to which characters.

**Q: Database for session persistence across proxy restarts?**
A: Not in v1. Memory-only sessions. If proxy restarts, all sessions lost. Add Redis/PostgreSQL persistence in v2 if operating as hosted service.

## Dependencies

**Existing (from mud-web-proxy):**
- `ws` ^8.0.0 - WebSocket server
- `node` >=14.0.0 - Runtime
- Built-in `net` module - TCP sockets
- Built-in `zlib` module - MCCP decompression

**New additions:**
- `apn` ^2.2.0 - Apple Push Notification Service client
- `winston` ^3.8.0 - Structured logging
- `uuid` ^9.0.0 - Session ID generation

**External services:**
- Apple Push Notification Service (APNS)
- Let's Encrypt for TLS certificates
- MUD servers (user-provided)

**Infrastructure:**
- VPS provider (DigitalOcean, Hetzner, Vultr, Linode)
- Domain name with DNS management
- APNS authentication key (.p8 file from Apple Developer)

**Development:**
- Node.js 18+ (LTS)
- npm or yarn
- Git for version control
- Text editor with JavaScript support

## Documentation Needs

**User:**
- How to run your own proxy (VPS setup guide)
- How to configure MUDBasher to use proxy
- How to add custom notification triggers
- Troubleshooting connection issues

**Developer:**
- API reference for WebSocket protocol
- Session lifecycle diagrams
- Deployment guide (systemd, pm2, Docker)
- APNS setup and certificate management

**Operations:**
- Monitoring and alerting setup
- Log aggregation and analysis
- Scaling guidance (when to upgrade VPS)
- Backup and disaster recovery (if adding persistence)

## Future Enhancements (Post-MVP)

- **Multi-user hosted service** with user accounts, authentication, subscription billing
- **Session persistence** to Redis or PostgreSQL for proxy restart tolerance
- **Auto-reconnect** to MUD on telnet connection drop
- **Shared scrollback** across iOS devices via cloud sync
- **Web client** using same proxy infrastructure
- **MUD server auto-discovery** using MUD Connector protocol
- **Encryption at rest** for buffered content (HIPAA compliance if adding private data)
- **Analytics dashboard** for session metrics, popular MUDs, notification patterns
- **Custom protocol support** (SSH tunnels, SSL-wrapped telnet)
- **IPv6 support** for MUD server connections
