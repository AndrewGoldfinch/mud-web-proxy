# Session Integration Guide

## Overview

This guide explains how to integrate the session persistence layer into the existing mud-web-proxy.

## What Was Built

The session persistence system consists of:

1. **CircularBuffer** (`src/circular-buffer.ts`) - Fixed-size buffer with sequence numbering
2. **Session** (`src/session.ts`) - Manages telnet connection and buffer
3. **SessionManager** (`src/session-manager.ts`) - Stores and manages all sessions
4. **TriggerMatcher** (`src/trigger-matcher.ts`) - Pattern matching for notifications
5. **NotificationManager** (`src/notification-manager.ts`) - APNS integration
6. **SessionIntegration** (`src/session-integration.ts`) - High-level integration module

## New Protocol Messages

### Client → Proxy

**Connect** (creates new session):

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

**Resume** (reattaches to existing session):

```json
{
  "type": "resume",
  "sessionId": "...",
  "token": "...",
  "lastSeq": 1042
}
```

**Input** (send command to MUD):

```json
{
  "type": "input",
  "text": "look"
}
```

**NAWS** (update window size):

```json
{
  "type": "naws",
  "width": 80,
  "height": 40
}
```

### Proxy → Client

**Session Created**:

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

## Integration Example

Add to top of wsproxy.ts:

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

Modify `srv.parse`:

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

Modify `srv.closeSocket`:

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

### Environment Variables

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

### Unit Tests

```bash
bun test src/circular-buffer.test.ts
bun test src/session.test.ts
bun test src/session-manager.test.ts
bun test src/trigger-matcher.test.ts
bun test src/notification-manager.test.ts
```

### Manual Testing

1. Connect with new protocol:

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

2. Disconnect and reconnect with resume:

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

3. Test notifications (background app, send tell):

```javascript
// In MUD
> tell testuser Hello!
// Should trigger APNS notification
```

## Security Considerations

1. **Auth Tokens**: 64-character hex strings, generated with crypto.randomBytes(32)
2. **Token Validation**: Required for resume operations
3. **Rate Limiting**: 5 sessions per device, 10 per IP
4. **Session Timeout**: 24 hours of inactivity
5. **No Password Storage**: Credentials pass through to MUD

## Performance

- **Buffer Size**: 50KB per session (configurable)
- **Session Capacity**: 50+ concurrent on 512MB VPS
- **Cleanup Interval**: Every 5 minutes
- **Notification Retry**: Every 1 minute, max 3 retries

## Troubleshooting

### Session not found

- Check session ID and token are correct
- Session may have timed out (24 hours)

### Notifications not working

- Check APNS key file exists and is readable
- Verify device token is being sent
- Check APNS environment (sandbox vs production)

### Buffer not replaying

- Verify lastSeq parameter in resume
- Check if sequence is still in buffer (may have been evicted)

## Migration Guide

The session integration requires the new message format:

- Messages must have a `type` field: `connect`, `resume`, `input`, `naws`, or `disconnect`
- Messages without a `type` field are forwarded directly to the MUD server

To migrate:

1. Deploy updated proxy
2. Update client to use new message format with `type` field
3. Add APNS configuration (optional)
4. Test session persistence and notifications
