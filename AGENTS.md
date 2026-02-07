# AGENTS.md - Coding Guidelines for mud-web-proxy

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
```

**Note**: Tests are not configured (package.json test script exits with error).

## Code Style Guidelines

### TypeScript Configuration

- Target: ES2022 with ESNext modules
- Strict mode enabled with strictNullChecks
- Module resolution: bundler
- Output: `dist/` directory with source maps and declarations

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
- **Private**: Prefix with underscore for internal use (e.g., `_unusedParam`)

### Import/Export Style

```typescript
// Use ES modules (type: "module" in package.json)
import net from 'net';
import { fileURLToPath } from 'url';
import type { WebSocket } from 'ws'; // Type imports
import * as ws from 'ws'; // Namespace imports

// Avoid default exports - use named exports
export interface MyInterface {}
```

### Type Safety

- Always use explicit types on function parameters and return types
- Use `unknown` instead of `any` where possible
- Enable `noImplicitAny` and `strictFunctionTypes`
- Use type assertions sparingly: `as Type` only when necessary
- Prefer interfaces over type aliases for object shapes

### Error Handling

```typescript
// Use try/catch with proper error typing
try {
  const data = await fs.promises.readFile('./chat.json', 'utf8');
} catch (err) {
  srv.log('Chat log error: ' + err);
  return [];
}

// Log errors using srv.log() helper
srv.log('Error: ' + (err as Error).toString());
```

### ESLint Rules

- `no-console`: warn (use srv.log instead)
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/no-unused-vars`: error (ignore args starting with `_`)
- `prettier/prettier`: error (enforces formatting)

### File Organization

- Main source: `wsproxy.ts` (single file application)
- Compiled output: `dist/wsproxy.js`
- Config files at root: `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`

### Special Conventions

- Use `Bun` runtime for development (faster than Node.js)
- Use `__dirname` emulation for ES modules: `fileURLToPath(import.meta.url)`
- Buffer handling: Explicitly use `Buffer.from()` for binary data
- Telnet protocol constants: Defined in `ProtocolConstants` interface

### Async Patterns

```typescript
// Prefer async/await over callbacks
const loadChatLog = async (): Promise<ChatEntry[]> => {};

// Handle top-level await properly
const init = async () => {};
init().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
```

### Comments

- Use block comments for file headers
- Use `//` for inline explanations
- Avoid JSDoc unless documenting public APIs

## Dependencies

- **Runtime**: `ws` (WebSocket), `iconv-lite` (encoding), `uglify-js` (minification)
- **Dev**: TypeScript, ESLint, Prettier, Bun

## Git Workflow

- No pre-commit hooks configured
- Build outputs are in `dist/` (check if committed)
- Node modules are gitignored
