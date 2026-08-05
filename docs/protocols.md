# Client protocols

mud-web-proxy speaks two WebSocket protocols. Both are supported in v4 and both
enforce identical policy — same target rules, same authentication, same limits.
They differ only in framing and capability.

| Protocol   | Use it when                                                       |
| ---------- | ----------------------------------------------------------------- |
| **Typed**  | You are writing a new client. JSON envelopes, resumable sessions. |
| **Legacy** | You are maintaining an existing client. Base64 frames, no resume. |

**The legacy protocol is supported but frozen.** It will keep working, and it
will not gain capabilities. New clients should use the typed protocol.

Every shape below is taken from the implementation. Where a bound is stated, it
is enforced.

## Connecting

```
wss://proxy.example.com/
```

Connect to the root path. There is no protocol selector — the proxy decides
per message: a JSON object with a `type` field is typed, a JSON object with a
`connect` field and no `type` is legacy, and anything else is player input.

### Authentication

When `AUTH_MODE=shared-secret`, every upgrade needs the secret. Two transports:

```http
Authorization: Bearer <secret>
```

Preferred. The scheme is case-insensitive.

```
wss://proxy.example.com/?secret=<secret>
```

Only when the operator sets `AUTH_ALLOW_QUERY_SECRET=true`. It exists because
browsers cannot set headers on a WebSocket handshake, and it puts the secret in
URLs, access logs, and referrer headers. Prefer the header wherever you can
send one.

When `REQUIRE_APP_AUTH=true` the upgrade additionally needs a valid Apple App
Attest assertion. That path is experimental — see
[the security model](security.md).

### Failures before the socket opens

Upgrade rejections are **HTTP responses, not JSON envelopes**. Your error
handling needs to cover both layers, because these never reach `onmessage`:

| Status | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `401`  | Missing, malformed, or wrong shared secret; or App Attest failed |
| `403`  | Origin not in `ALLOWED_ORIGINS`, or absent when required         |

`ALLOWED_ORIGINS` constrains browsers only — a native client sets whatever
Origin it likes, so this is hardening, never authentication.

## Typed protocol

JSON objects in both directions, one per WebSocket message.

### Client → server

Seven message types. Anything with an unrecognised `type` is rejected with
`invalid_request` rather than forwarded to the MUD.

#### `connect`

Open a session.

| Field         | Type    | Required | Bounds                   |
| ------------- | ------- | -------- | ------------------------ |
| `type`        | string  | yes      | `"connect"`              |
| `host`        | string  | yes      | Subject to `TARGET_MODE` |
| `port`        | integer | yes      | 1–65535                  |
| `deviceToken` | string  | no       | APNS device token        |
| `width`       | integer | no       | 1–65535                  |
| `height`      | integer | no       | 1–65535                  |

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
so a client cannot assume it may choose.

A `debug` field is accepted and **deliberately ignored**. It once enabled
per-client logging of forwarded input; log level is an operator decision only.

#### `resume`

Reattach to an existing session. See [Resuming](#resuming).

| Field       | Type    | Required | Notes                                  |
| ----------- | ------- | -------- | -------------------------------------- |
| `type`      | string  | yes      | `"resume"`                             |
| `sessionId` | string  | yes      | From the `session` envelope            |
| `token`     | string  | yes      | From the `session` envelope            |
| `lastSeq`   | integer | yes      | Highest sequence you have **received** |

```json
{ "type": "resume", "sessionId": "…", "token": "…", "lastSeq": 412 }
```

#### `input`

Send a line to the MUD.

```json
{ "type": "input", "text": "look\r\n" }
```

#### `naws`

Report a window size change. Both dimensions 1–65535.

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

### Server → client

#### `session`

Sent once, after a successful `connect`. **Store `sessionId` and `token` — they
are the only way to resume.**

```json
{
  "type": "session",
  "sessionId": "…",
  "token": "…",
  "capabilities": ["activityToken", "syncAck", "echoState"]
}
```

#### `resumed`

Sent after a successful `resume`, **before** any replayed frames, so you can
complete the handshake without waiting on replay timing.

```json
{
  "type": "resumed",
  "sessionId": "…",
  "capabilities": ["activityToken", "syncAck", "echoState"]
}
```

#### `data`

MUD output. `payload` is base64 — decode it, do not render it directly.

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
echo off — a password prompt. Stop displaying typed characters until it flips
back.

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
| `session_expired`   | The session is gone — timed out, reaped, or lost to a restart                                                   |
| `connection_failed` | The proxy could not reach the MUD                                                                               |
| `rate_limited`      | Connection or message limits exceeded                                                                           |

`invalid_request` is your fault and retrying unchanged will fail again.
`connection_failed` is upstream and may succeed on retry. `session_expired`
means start over with `connect` — do not retry `resume`.

## Resuming

Sessions outlive the WebSocket. If the socket drops, reconnect and `resume`.

**`lastSeq` is the highest sequence number you have already received. Replay
resumes strictly after it.** Both halves matter: you send what you _have_, and
the proxy sends what comes _next_. You will not be sent `lastSeq` again.

```json
{ "type": "resume", "sessionId": "…", "token": "…", "lastSeq": 412 }
```

Received up to 412, so 413 onwards is replayed.

The rest of the contract:

- **`lastSeq: 0` means "I have nothing"** and replays the entire buffer.
- **Replayed frames carry `replayed: true`.** Live frames omit it. Use it to
  distinguish history from new output — to suppress notification sounds on
  replay, for instance.
- **Sequences are per-session and monotonic.** They do not reset on resume and
  do not restart at 1 after reconnecting.
- **Resume state does not survive a server restart.** Sessions are memory-local
  and there is no persistence. After a proxy restart every `resume` fails with
  `session_expired` and clients must `connect` again.

### A limitation you cannot detect

If your `lastSeq` has already been **evicted** from the output buffer — because
the MUD produced more than `OUTPUT_BUFFER_BYTES` while you were away — replay
begins at the oldest surviving chunk instead.

There is **no error and no gap indication**. You will receive a contiguous-
looking run of frames whose first sequence is higher than `lastSeq + 1`, and
nothing tells you output was lost.

If that matters to your client, compare the first replayed `seq` against your
`lastSeq + 1` yourself. A jump means output was dropped.

## Legacy protocol

Supported, frozen, and documented so existing clients keep working.

### Opening

One JSON message. No `type` field — that is what distinguishes it.

```json
{ "connect": 1, "host": "mud.example.com", "port": 4000 }
```

`host` and `port` are optional; omitting them uses the operator's configured
default target. Policy still applies — a bare `{"connect": 1}` is not
privileged.

### Framing

**Server → client:** bare base64, no envelope. Decode and render. Frames may be
deflate-compressed when MCCP is negotiated.

**Client → server:** raw text, not JSON. Anything that is not a JSON object is
forwarded to the MUD as player input.

### Rejections

Legacy clients cannot parse JSON envelopes, so errors arrive as **plain text in
the same base64 framing**, wrapped in CRLFs and followed by a socket close:

| Text                                    | Cause                             |
| --------------------------------------- | --------------------------------- |
| `This connection already has a session` | A second `connect` on one socket  |
| `Error: maybe the mud server is down?`  | The upstream dial failed          |
| `Timeout: server port is down.`         | The upstream connection timed out |

Target-policy denials arrive the same way, carrying the policy's own reason.

### What legacy does not have

No sessions, no `sessionId`, no resume, no sequence numbers, no typed GMCP or
echo envelopes. A dropped socket loses the connection permanently. GMCP and
MCCP still work at the telnet layer — they simply are not surfaced as
structured messages.

## Telnet pass-through

The proxy negotiates these on your behalf, so a client does not implement
telnet itself:

| Option          | Effect                                                    |
| --------------- | --------------------------------------------------------- |
| MCCP2           | Compression, transparently decompressed before you see it |
| GMCP / ATCP     | Surfaced as `gmcp` envelopes (typed protocol)             |
| MSDP            | Structured MUD data                                       |
| MXP             | In-band markup, passed through in `data`                  |
| TTYPE           | Terminal type, answered on your behalf                    |
| CHARSET / UTF-8 | Character set negotiation                                 |
| NAWS            | Window size, driven by your `naws` messages               |
| ECHO            | Surfaced as `echo` envelopes; drives password masking     |
| SGA, NEW-ENV    | Suppress go-ahead and environment negotiation             |

MUD output reaches you as bytes in `data.payload`. ANSI colour, MXP markup, and
anything else the MUD emits arrive intact — **the proxy does not sanitise game
output and cannot.** Rendering it safely is your client's responsibility.

## Limits

| Limit                          | Default | What you see when you exceed it          |
| ------------------------------ | ------- | ---------------------------------------- |
| Messages per connection/second | 60      | `error` with `rate_limited`              |
| Messages per address/second    | 240     | `error` with `rate_limited`              |
| Sessions per device            | 5       | `error` with `rate_limited` on `connect` |
| Sessions per IP                | 10      | `error` with `rate_limited` on `connect` |
| Telnet subnegotiation bytes    | 65536   | The oversized sequence is dropped        |
| Output buffer bytes            | 51200   | Oldest buffered output is evicted        |

All are operator-configurable — see the
[configuration reference](configuration.md). Treat the defaults as a floor to
design against, not a guarantee.

**Heartbeat.** The proxy pings every 30 seconds and reclaims peers silent for 90. Standard WebSocket pong handling is enough; a client that ignores pings
gets disconnected as dead.

## Parity guarantee

Both protocols enforce **identical** target policy, authentication, and
resource limits. The same authorization path serves both, so neither is a way
around a restriction the other applies.

They deliberately do not share a data plane — a legacy client cannot consume
typed envelopes and holds no session token — but policy is shared, which is
what stops the two drifting into different security postures.

Upstream TLS behaviour is likewise identical: `MUD_TLS_MODE` governs both. See
[the security model](security.md#tls-boundaries).
