# Session integration guide

## Overview

This guide explains how to integrate the session persistence layer into
mud-web-proxy.

## Components

The session persistence system consists of the following modules:

- **CircularBuffer** (`src/circular-buffer.ts`): a fixed-size buffer with
  sequence numbering.
- **Session** (`src/session.ts`): manages one telnet connection and its buffer.
- **SessionManager** (`src/session-manager.ts`): stores and manages all
  sessions.
- **TriggerMatcher** (`src/trigger-matcher.ts`): matches patterns for
  notifications.
- **NotificationManager** (`src/notification-manager.ts`): integrates with
  APNS.
- **SessionIntegration** (`src/session-integration.ts`): the high-level
  integration module.

## Protocol messages

### Client to proxy

**Connect** (creates a session):

```json
{
  "type": "connect",
  "host": "aardmud.org",
  "port": 4000,
  "deviceToken": "...",
  "width": 80,
  "height": 40
}
```

**Resume** (reattaches to a running session):

```json
{
  "type": "resume",
  "sessionId": "...",
  "token": "...",
  "lastSeq": 1042
}
```

**Input** (sends a command to the MUD):

```json
{
  "type": "input",
  "text": "look"
}
```

**NAWS** (updates the window size):

```json
{
  "type": "naws",
  "width": 80,
  "height": 40
}
```

### Proxy to client

**Session created**:

```json
{
  "type": "session",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "token": "9f86d081..."
}
```

**Data**:

```json
{
  "type": "data",
  "seq": 1043,
  "payload": "base64-encoded-data"
}
```

**GMCP**:

```json
{
  "type": "gmcp",
  "seq": 1044,
  "package": "Char.Vitals",
  "data": { ... }
}
```

**Error**:

```json
{
  "type": "error",
  "code": "invalid_resume",
  "message": "Session not found"
}
```

## Integration example

Add the following to the top of the `wsproxy.ts` file:

```typescript
import { SessionIntegration } from './src/session-integration';

// Create session integration
const sessionIntegration = new SessionIntegration({
  sessions: {
    timeoutHours: 24,
    maxPerDevice: 5,
    maxPerIP: 10,
  },
  buffer: {
    sizeKB: 50,
  },
  triggers: {
    rateLimit: {
      perTypePerMinute: 1,
      totalPerHour: 10,
    },
  },
  apns: {
    keyPath: './config/AuthKey.p8',
    keyId: 'ABC123XYZ',
    teamId: 'DEF456UVW',
    topic: 'com.yourcompany.mudbasher',
    environment: 'sandbox',
  },
});
```

Modify the `srv.parse` function:

```typescript
parse: function (s: SocketExtended, d: Buffer): number {
  if (d[0] !== '{'.charCodeAt(0)) return 0;

  try {
    const msg = d.toString();
    const parsed = JSON.parse(msg);
    if (parsed && parsed.type) {
      const handled = sessionIntegration.parseNewMessage(s, d);
      if (handled) return 1;
    }
  } catch (_err) {
    // Invalid JSON, forward to MUD
  }

  return 0;
},
```

Modify the `srv.closeSocket` function:

```typescript
closeSocket: function (s: SocketExtended): void {
  // Check if this socket is part of a session
  if (sessionIntegration.hasSession(s)) {
    // Detach from session (don't terminate telnet)
    sessionIntegration.handleSocketClose(s);
    // Remove from socket list
    const i = server.sockets.indexOf(s);
    if (i != -1) server.sockets.splice(i, 1);
    return;
  }

  // Legacy close behavior
  if (s.ts) {
    s.terminate();
  }
  // ... rest of close logic
},
```

## Configuration

### Environment variables

```bash
# Session management
SESSION_TIMEOUT_HOURS=24
MAX_SESSIONS_PER_DEVICE=5
MAX_CONNECTIONS_PER_IP=10

# Buffer
BUFFER_SIZE_KB=50

# APNS (optional)
APNS_KEY_PATH=./config/AuthKey.p8
APNS_KEY_ID=ABC123XYZ
APNS_TEAM_ID=DEF456UVW
APNS_TOPIC=com.yourcompany.mudbasher
APNS_ENVIRONMENT=sandbox
```

## Testing

### Unit tests

```bash
bun test src/circular-buffer.test.ts
bun test src/session.test.ts
bun test src/session-manager.test.ts
bun test src/trigger-matcher.test.ts
bun test src/notification-manager.test.ts
```

### Manual testing

1. Connect with the typed protocol:

```javascript
const ws = new WebSocket('wss://localhost:6200');
ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: 'connect',
      host: 'aardmud.org',
      port: 4000,
    }),
  );
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'session') {
    console.log('Session ID:', msg.sessionId);
    console.log('Auth Token:', msg.token);
  }
};
```

2. Disconnect, then reconnect with a resume message:

```javascript
ws.send(
  JSON.stringify({
    type: 'resume',
    sessionId: sessionId,
    token: authToken,
    lastSeq: lastSequence,
  }),
);
```

3. Background the app, then send a tell to test notifications:

```javascript
// In MUD
> tell testuser Hello!
// Should trigger APNS notification
```

## Security considerations

- **Authentication tokens**: 64-character hex strings, generated with
  `crypto.randomBytes(32)`.
- **Token validation**: required for every resume operation.
- **Rate limiting**: 5 sessions per device, 10 per IP address.
- **Session timeout**: 24 hours of inactivity.
- **No password storage**: credentials pass through to the MUD.

## Performance

- **Buffer size**: 50 KB per session, configurable.
- **Session capacity**: at least 50 concurrent sessions on a 512 MB VPS.
- **Cleanup interval**: every five minutes.
- **Notification retry**: every minute, up to three retries.

## Troubleshooting

### Session not found

- Check that the session ID and the token are correct.
- The session might have timed out after 24 hours of inactivity.

### Notifications not working

- Check that the APNS key file exists and is readable.
- Verify that the client sends the device token.
- Check the APNS environment: `sandbox` or `production`.

### Buffer not replaying

- Verify the `lastSeq` parameter in the resume message.
- Check whether the sequence is still in the buffer. The buffer might have
  evicted it.

## Migration

The session integration requires the typed message format:

- Each message must have a `type` field: `connect`, `resume`, `input`, `naws`,
  or `disconnect`.
- The proxy forwards messages without a `type` field directly to the MUD
  server.

To migrate, follow these steps:

1. Deploy the updated proxy.
2. Update the client to send the `type` field on every message.
3. Optional: Add APNS configuration.
4. Test session persistence and notifications.
