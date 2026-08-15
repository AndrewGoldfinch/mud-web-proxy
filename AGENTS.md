# AGENTS.md - Coding Guidelines for mud-web-proxy

This file provides guidance to agentic coding assistants working in this repository.

## Project Overview

mud-web-proxy is a WebSocket-to-Telnet proxy for MUD/MUSH/MOO game servers.
It enables web browsers to connect to legacy telnet MUD servers over secure
WSS/HTTPS connections.

## Build & Development Commands

```bash
# Build (compile TypeScript to dist/)
bun run build

# Development (run with Bun, hot reload)
bun dev

# Production (run compiled JS)
bun start

# Linting
bun run lint
bun run lint:fix

# Type checking (no emit)
bun run typecheck

# Run all tests with coverage
bun run test

# Run unit tests only
bun run test:unit

# Run a single test file
bun test tests/circular-buffer.test.ts
bun test tests/telnet-negotiation-part1.test.ts

# Run a single test with pattern matching
bun test -t "should append data"

# Run e2e tests
bun run test:e2e
bun run test:mock
```

## Architecture

**Single-file design**: Main server logic lives in `wsproxy.ts`. A central
`srv` object holds both configuration and methods.

**Data flow**: WebSocket Client → `parse()` (JSON commands) → `initT()`
(telnet connection) → MUD Server → `sendClient()` (protocol negotiation +
data transform) → WebSocket Client

**Supporting modules**: `src/` contains helper modules (types, circular-buffer,
session-manager, trigger-matcher, etc.)

## Code Style Guidelines

### TypeScript Configuration

- Target: ES2022 with ESNext modules
- Strict mode enabled with `strictNullChecks`
- Module resolution: bundler
- Output: `dist/` directory with source maps and declarations
- `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` enabled

### Formatting (Prettier)

- Print width: 79 characters
- Tab width: 2 spaces (no tabs)
- Single quotes
- Semicolons required
- Arrow functions: always use parentheses
- Bracket spacing: enabled

### Naming Conventions

- **Variables/functions**: camelCase (e.g., `loadChatLog`, `serverState`)
- **Interfaces/Types**: PascalCase (e.g., `SocketExtended`, `ClientRequest`)
- **Constants**: UPPER_SNAKE_CASE for true constants (e.g., `ONLY_ALLOW_DEFAULT_SERVER`)
- **Private/internal**: Prefix with underscore (e.g., `_unusedParam`)
- **Files**: kebab-case for modules (e.g., `circular-buffer.ts`)

### Import/Export Style

```typescript
// ES modules (type: "module" in package.json)
import net from 'net';
import { fileURLToPath } from 'url';
import type { WebSocket } from 'ws'; // Type-only imports
import * as ws from 'ws'; // Namespace imports
import { CircularBuffer } from './circular-buffer'; // Named imports

// Prefer named exports over default exports
export interface MyInterface {}
export function myFunction(): void {}
```

### Type Safety

- Always use explicit types on function parameters and return types
- Never `unknown` on a parameter or return type — `no-unknown-parameters` and
  `no-unknown-returns` reject it. Parse at the I/O boundary with a zod schema
  and pass the decoded type inward. The one exception the rules allow is a
  parameter named `cause`, for a caught value.
- Use type assertions sparingly, and every one needs a `SAFETY:` comment
  stating the invariant TypeScript cannot see (`as const` is exempt)
- Prefer interfaces over type aliases for object shapes — and note that a
  `Record<string, T>` annotation on a known literal is rejected by
  `no-known-value-widening`; use a named interface or `satisfies`
- Caught errors go through `errorText(err)` / `toError(err)` from
  `src/error-text.ts`, never `(err as Error)`: JavaScript lets any value be
  thrown, and the cast produced `undefined` for anything that was not an Error

### Error Handling

```typescript
// Use try/catch, and render the caught value rather than asserting its type
import { errorText } from './src/error-text';

try {
  const data = await fs.promises.readFile('./chat.json', 'utf8');
} catch (err) {
  srv.log('Error: ' + errorText(err));
  return [];
}
```

### Logging

- Use `srv.log()` instead of `console.log` (oxlint warns on `no-console`)
- Log levels available: DEBUG, INFO, WARN, ERROR
- Set via `LOG_LEVEL` environment variable

### Async Patterns

```typescript
// Prefer async/await over callbacks
const loadChatLog = async (): Promise<ChatEntry[]> => {
  // ...
};

// Top-level async pattern
const init = async (): Promise<void> => {
  // ...
};
init().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
```

### Comments

- Block comments for file headers and complex sections
- Use `//` for inline explanations
- Avoid JSDoc unless documenting public APIs
- Document protocol constants and negotiation states

## Lint Rules

Oxlint (`.oxlintrc.json`). The `correctness` category is on, plus:

- `no-console`: warn (use `srv.log` instead)
- `typescript/no-explicit-any`: warn
- `no-unused-vars`: error (ignore args starting with `_`)
- the `anti-slop` plugin's rules: error (see `tools/oxlint/anti-slop/`)

Oxlint honours `// eslint-disable-next-line <rule>` comments, which is why the
existing suppressions throughout the codebase still work unchanged.

## File Organization

- Main entry: `wsproxy.ts` (single file application root)
- Source modules: `src/` (types, utilities, session management)
- Compiled output: `dist/`
- Tests: `tests/` with mocks in `tests/mocks/`
- E2E tests: `tests/e2e/`
- Config files at root: `tsconfig.json`, `.oxlintrc.json`, `.prettierrc.json`

## Dependencies

- **Runtime**: `ws` (WebSocket), `iconv-lite` (encoding), `cbor-x` (App
  Attest), `zod` (boundary schemas — every untrusted payload is parsed by a
  declared schema rather than hand-checked)
- **Dev**: TypeScript, Oxlint, Prettier, Bun test runner

## Special Conventions

- Use `Bun` runtime for development (faster than Node.js)
- `__dirname` emulation: `fileURLToPath(import.meta.url)` (ES modules)
- Buffer handling: Explicitly use `Buffer.from()` for binary data
- Telnet protocol constants defined inline or in `ProtocolConstants` interface

## Git Workflow

- No pre-commit hooks configured
- Build outputs in `dist/` (check if committed)
- Node modules are gitignored
