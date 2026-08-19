# Client protocols

mud-web-proxy speaks two WebSocket protocols. Both are supported in v4 and both
enforce identical policy—same target rules, same authentication, same limits.
They differ only in framing and capability.

| Protocol | Use it when                                                                 |
| -------- | --------------------------------------------------------------------------- |
| Typed    | You are writing a client from scratch. JSON envelopes, resumable sessions.  |
| Legacy   | You are maintaining a client that already exists. Base64 frames, no resume. |

The legacy protocol is supported but frozen. It keeps working, and it doesn't
gain capabilities. Write any client from scratch against the typed protocol.

Every shape in this document comes from the implementation. Where this document
states a bound, the proxy enforces it.

## Connect to the proxy

```
wss://proxy.example.com/
```

Connect to the root path. There is no protocol selector. The proxy selects
per message: a JSON object with a `type` field is typed, a JSON object with a
`connect` field and no `type` is legacy, and anything else is player input.

### Authentication

When `AUTH_MODE=shared-secret`, every upgrade needs the secret. The secret has
two transports.

```http
Authorization: Bearer <secret>
```

Use the header form when you can. The scheme is case-insensitive.

```
wss://proxy.example.com/?secret=<secret>
```

The query form works only when the operator sets
`AUTH_ALLOW_QUERY_SECRET=true`. It exists because browsers can't set headers
on a WebSocket handshake, and it puts the secret into URLs, access logs, and
referrer headers. Prefer the header wherever you can send one.

When `REQUIRE_APP_AUTH=true` the upgrade additionally needs a valid Apple App
Attest assertion. That path is experimental. For details, see
[Security model and threat model](security.md).

### Failures before the socket opens

The proxy closes a refused connection with a WebSocket close frame, not a JSON
envelope. Read `event.code` and `event.reason` in your `onclose` handler. None
of this information reaches `onmessage`.

The reason string is the HTTP status the refusal corresponds to, so it stays
greppable in client logs alongside server logs:

| Close code | Reason                    | Meaning                                                          |
| ---------- | ------------------------- | ---------------------------------------------------------------- |
| `1008`     | `401 Unauthorized`        | Missing, malformed, or wrong shared secret; or App Attest failed |
| `1008`     | `403 Forbidden`           | Origin not in `ALLOWED_ORIGINS`, or absent when required         |
| `1013`     | `429 Too Many Requests`   | Too many failed attempts from your address; back off and retry   |
| `1013`     | `503 Service Unavailable` | The proxy is shutting down or draining                           |

The split is what matters for retry logic: `1008` doesn't succeed on retry,
because the credential or the Origin has to change, whereas `1013` is
temporary and worth retrying after a wait.

Don't expect an HTTP status. The proxy runs on Bun, which discards writes to
the upgrade socket, so a status line never reaches you. The proxy completes the
handshake and immediately closes it with one of the preceding codes instead.
This behavior also gives browsers more than a status could: JavaScript can't
read the status of a failed WebSocket handshake, but it can read a close code
and a reason.

`ALLOWED_ORIGINS` constrains browsers only. A native client can set any Origin
value, so this setting is hardening, never authentication.

## Typed protocol

JSON objects in both directions, one per WebSocket message.

### Client to server

The typed protocol has seven client message types. The proxy rejects anything
with an unrecognized `type` with `invalid_request` rather than forwarding it to
the MUD.

#### `connect`

Open a session.

| Field         | Type    | Required | Bounds                   |
| ------------- | ------- | -------- | ------------------------ |
| `type`        | string  | yes      | `"connect"`              |
| `host`        | string  | yes      | Subject to `TARGET_MODE` |
| `port`        | integer | yes      | 1-65535                  |
| `deviceToken` | string  | no       | APNS device token        |
| `width`       | integer | no       | 1-65535                  |
| `height`      | integer | no       | 1-65535                  |

```json
{
  "type": "connect",
  "host": "mud.example.com",
  "port": 4000,
  "width": 100,
  "height": 40
}
```

Whether your `host` is permitted depends on the operator's `TARGET_MODE`. In
`fixed` mode only the configured target is allowed and anything else is denied,
so a client can't assume that it gets to choose.

The proxy accepts a `debug` field and deliberately ignores it. It once enabled
per-client logging of forwarded input; log level is an operator decision only.

#### `resume`

Reattach to an existing session. See [Resume a session](#resume-a-session).

| Field       | Type    | Required | Notes                                     |
| ----------- | ------- | -------- | ----------------------------------------- |
| `type`      | string  | yes      | `"resume"`                                |
| `sessionId` | string  | yes      | From the `session` envelope               |
| `token`     | string  | yes      | From the `session` envelope               |
| `lastSeq`   | integer | yes      | Highest sequence number you have received |

```json
{ "type": "resume", "sessionId": "…", "token": "…", "lastSeq": 412 }
```

#### `input`

Send a line to the MUD.

```json
{ "type": "input", "text": "look\r\n" }
```

#### `naws`

Report a window size change. Both dimensions 1-65535.

```json
{ "type": "naws", "width": 120, "height": 50 }
```

#### `syncAck`

Acknowledge receipt up to a sequence, so the proxy can trim what it holds.

```json
{ "type": "syncAck", "sessionId": "…", "lastSeq": 412 }
```

#### `activityToken`

Supply an iOS Live Activity token for background updates.

```json
{ "type": "activityToken", "token": "…" }
```

#### `disconnect`

Close the session and its upstream connection.

```json
{ "type": "disconnect" }
```

### Server to client

#### `session`

The proxy sends this envelope once, after a successful `connect`. Store
`sessionId` and `token`: they are the only way to resume.

```json
{
  "type": "session",
  "sessionId": "…",
  "token": "…",
  "capabilities": ["activityToken", "syncAck", "echoState"]
}
```

#### `resumed`

The proxy sends this envelope after a successful `resume` and before any
replayed frames, so you can complete the handshake without waiting on replay
timing.

```json
{
  "type": "resumed",
  "sessionId": "…",
  "capabilities": ["activityToken", "syncAck", "echoState"]
}
```

#### `data`

MUD output. `payload` is base64. Decode it, and don't render it directly.

```json
{ "type": "data", "seq": 413, "payload": "SGVsbG8sIHdvcmxkLg==" }
```

Replayed frames carry `"replayed": true`. Live frames omit the field entirely.

#### `gmcp`

A GMCP or ATCP package the MUD sent.

```json
{ "type": "gmcp", "seq": 414, "package": "Char.Vitals", "data": { "hp": 100 } }
```

#### `echo`

Telnet ECHO state changed. `suppressed: true` means the MUD asked for local
echo off, which signals a password prompt. Stop displaying typed characters
until the state reverts.

```json
{ "type": "echo", "seq": 415, "suppressed": true }
```

#### `error`

```json
{ "type": "error", "code": "invalid_request", "field": "port", "message": "…" }
```

`field` is present only when a specific field was at fault. Its presence is how
you distinguish "my message was wrong" from "something upstream failed".

#### `disconnected`

The upstream MUD connection ended.

```json
{ "type": "disconnected", "sessionId": "…", "reason": "MUD connection closed" }
```

### Error codes

| Code                | Means                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `invalid_request`   | Malformed message, unknown type, out-of-bounds field, target not permitted, or a second `connect` on one socket |
| `invalid_resume`    | `sessionId` or `token` did not match                                                                            |
| `session_expired`   | The session is gone: timed out, reclaimed, or lost to a restart                                                 |
| `connection_failed` | The proxy could not reach the MUD                                                                               |
| `rate_limited`      | Connection or message limits exceeded                                                                           |

`invalid_request` is your fault, and retrying unchanged fails again.
`connection_failed` is upstream and might succeed on retry. `session_expired`
means that you start over with `connect`. Don't retry `resume`.

## Resume a session

Sessions outlive the WebSocket. If the socket drops, reconnect and `resume`.

`lastSeq` is the highest sequence number you have already received, and replay
resumes strictly after it. Both halves matter: you send what you _have_, and
the proxy sends what comes _next_. The proxy doesn't send `lastSeq` again.

```json
{ "type": "resume", "sessionId": "…", "token": "…", "lastSeq": 412 }
```

In that example you received up to 412, so replay starts at 413.

The rest of the contract is as follows:

- **`lastSeq: 0` means "I have nothing"** and replays the entire buffer.
- **Replayed frames carry `replayed: true`.** Live frames omit it. Use it to
  distinguish history from live output—to suppress notification sounds on
  replay, for instance.
- **Sequences are per-session and monotonic.** They don't reset on resume, and
  they don't restart at 1 after you reconnect.
- **Resume state does not survive a server restart.** Sessions are memory-local
  and there is no persistence. After a proxy restart every `resume` fails with
  `session_expired` and clients must `connect` again.

### A limitation you can't detect

If the output buffer has already evicted your `lastSeq`—because the MUD
produced more than `OUTPUT_BUFFER_BYTES` while you were away—replay begins at
the oldest surviving chunk instead.

There is no error and no gap indication. You receive a contiguous-looking run
of frames whose first sequence is higher than `lastSeq + 1`, and nothing
reports that output was lost.

If that matters to your client, compare the first replayed `seq` against your
`lastSeq + 1` yourself. A jump means output was dropped.

## Legacy protocol

The legacy protocol is supported, frozen, and documented so that clients that
already exist keep working.

### Open a legacy connection

The client sends one JSON message with no `type` field. The missing `type`
field is what distinguishes the legacy protocol.

```json
{ "connect": 1, "host": "mud.example.com", "port": 4000 }
```

`host` and `port` are optional; omitting them uses the operator's configured
default target. Policy still applies—a bare `{"connect": 1}` is not
privileged.

### Frame format

**Server to client**: bare base64, with no envelope. Decode it and render it.
Frames can be deflate-compressed when MCCP is negotiated.

**Client to server**: raw text, not JSON. The proxy forwards anything that
isn't a JSON object to the MUD as player input.

### Rejections

Legacy clients cannot parse JSON envelopes, so errors arrive as plain text in the
same base64 framing, wrapped in CRLFs and followed by a socket close:

| Text                                    | Cause                             |
| --------------------------------------- | --------------------------------- |
| `This connection already has a session` | A second `connect` on one socket  |
| `Error: maybe the mud server is down?`  | The upstream dial failed          |
| `Timeout: server port is down.`         | The upstream connection timed out |

Target-policy denials arrive the same way, carrying the policy's own reason.

### What the legacy protocol doesn't have

No sessions, no `sessionId`, no resume, no sequence numbers, no typed GMCP or
echo envelopes. A dropped socket loses the connection permanently. GMCP and
MCCP still work at the telnet layer, but the proxy doesn't surface them as
structured messages.

## Telnet pass-through

The proxy negotiates the following telnet options on your behalf, so your
client doesn't implement telnet itself:

| Option         | Effect                                                    |
| -------------- | --------------------------------------------------------- |
| MCCP2          | Compression, transparently decompressed before you see it |
| GMCP and ATCP  | Surfaced as `gmcp` envelopes in the typed protocol        |
| MSDP           | Structured MUD data                                       |
| MXP            | In-band markup, passed through in `data`                  |
| TTYPE          | Terminal type, answered on your behalf                    |
| CHARSET, UTF-8 | Character set negotiation                                 |
| NAWS           | Window size, driven by your `naws` messages               |
| ECHO           | Surfaced as `echo` envelopes; drives password masking     |
| SGA, NEW-ENV   | Suppress go-ahead and environment negotiation             |

MUD output reaches you as bytes in `data.payload`. ANSI color, MXP markup, and
anything else the MUD emits arrive intact. The proxy doesn't sanitize game
output, and it can't. Rendering it safely is your client's responsibility.

## Limits

| Limit                              | Default | What you see when you exceed it             |
| ---------------------------------- | ------- | ------------------------------------------- |
| Messages per connection per second | `60`    | `error` with `rate_limited`                 |
| Messages per address per second    | `240`   | `error` with `rate_limited`                 |
| Sessions per device                | `5`     | `error` with `rate_limited` on `connect`    |
| Sessions per IP address            | `10`    | `error` with `rate_limited` on `connect`    |
| Telnet subnegotiation bytes        | `65536` | The proxy drops the oversized sequence      |
| Output buffer bytes                | `51200` | The proxy evicts the oldest buffered output |

The operator can configure all of them. For details, see the
[Configuration reference](configuration.md). Treat the defaults as a floor to
design against, not as a promise.

**Heartbeat.** The proxy pings every 30 seconds and reclaims peers that stay
silent for 90 seconds. Standard WebSocket pong handling is enough. The proxy
disconnects a client that ignores pings, treating it as dead.

## Policy parity between the protocols

Both protocols enforce identical target policy, authentication, and resource
limits. The same authorization path serves both, so neither one is a way around
a restriction that the other applies.

They deliberately don't share a data plane: a legacy client can't consume typed
envelopes and holds no session token. Policy is shared, which is what stops the
two from drifting into different security postures.

Upstream TLS behavior is likewise identical, because `MUD_TLS_MODE` governs
both. For details, see [TLS boundaries](security.md#tls-boundaries) in the
security model.
