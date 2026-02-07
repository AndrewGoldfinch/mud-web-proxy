# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mud-web-proxy is a WebSocket-to-Telnet proxy for MUD/MUSH/MOO game servers. It lets web browsers connect to legacy telnet MUD servers over secure WSS/HTTPS connections. Single-file TypeScript application (`wsproxy.ts`).

## Commands

```bash
bun run build        # Compile TypeScript to dist/
bun dev              # Run directly with Bun (development)
bun start            # Run compiled dist/wsproxy.js
bun run test         # Run tests with coverage (bun test --coverage)
bun run lint         # Lint with ESLint
bun run lint:fix     # Auto-fix lint issues
bun run typecheck    # Type-check without emitting
```

## Architecture

**Single-file design**: All server logic lives in `wsproxy.ts`. A central `srv` object holds both configuration and methods, acting as the application singleton.

**Data flow**: WebSocket Client → `parse()` (JSON commands) → `initT()` (telnet connection) → MUD Server → `sendClient()` (protocol negotiation + data transform) → WebSocket Client

**Key methods on `srv`**:
- `init()` — Creates HTTPS + WebSocketServer, loads chat log, sets up file watcher
- `parse()` — Parses JSON `ClientRequest` messages from WebSocket clients
- `initT()` — Opens telnet socket to target MUD server
- `sendClient()` — Processes incoming telnet data, handles protocol negotiation, optional zlib compression
- `forward()` — Forwards raw data from WebSocket to telnet
- `closeSocket()` — Cleans up both WebSocket and telnet connections

**Telnet protocol negotiation**: `sendClient()` contains a complex negotiation engine supporting MCCP, MXP, MSDP, GMCP, ATCP, TTYPE, CHARSET, UTF-8, SGA, NAWS, NEW-ENV, and ECHO. Each protocol has independent state flags on `SocketExtended`.

**Types**: `SocketExtended` (WebSocket + telnet state), `TelnetSocket` (net.Socket + custom `send()`), `ClientRequest` (parsed JSON from browser), `ServerConfig`, `ProtocolConstants`.

## Code Conventions

- **Runtime**: Bun (for dev and package management)
- **Module system**: ES modules (`"type": "module"`)
- **Target**: ES2022, strict mode
- **Formatting**: Prettier — 79 char width, 2-space indent, single quotes, semicolons
- **Naming**: camelCase (vars/functions), PascalCase (types/interfaces), UPPER_SNAKE_CASE (constants), `_` prefix for unused params
- **Logging**: Use `srv.log()` instead of `console.log` (ESLint warns on `no-console`)
- **Error typing**: Cast errors as `(err as Error)` in catch blocks
- **Imports**: ES module style, use `import type` for type-only imports
- **`__dirname` emulation**: `fileURLToPath(import.meta.url)` (required for ES modules)

## Test Structure

Tests use Bun's native test framework (`bun:test`). Test files are in `tests/` with mocks in `tests/mocks/` and config in `tests/config/`. Tests cover protocol negotiation, socket management, client requests, data transformation, chat, security, and integration.

## Security Notes

- `ONLY_ALLOW_DEFAULT_SERVER = true` restricts connections to the configured default MUD server
- SSL/TLS certificates are required for the HTTPS/WSS server
- Password mode detection (ECHO negotiation) omits passwords from logs
