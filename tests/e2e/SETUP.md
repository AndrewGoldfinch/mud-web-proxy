# E2E Test Setup

## Overview

The E2E tests automatically start a test proxy server on port 6299, so you do
not need to manually start the proxy.

Tests use non-TLS mode (`ws://`) to avoid certificate issues.

## Running Tests

Run the mock-only E2E suite:

```bash
bun run test:e2e:mock
```

The mock runner starts a local mock MUD and forces upstream MUD connections to
plain TCP with `MUD_TLS_MODE=plain`, so it does not depend on public MUD
availability or TLS auto-detection.

Run all real MUD E2E tests:

```bash
bun run test:e2e
```

Run specific real MUD tests:

```bash
bun run test:e2e:aardwolf
bun run test:e2e:rom
bun run test:e2e:discworld
bun run test:e2e:ire
bun run test:e2e:raw
```

## Configuration

Tracked files use the `.env.{mud}.example` suffix and contain public defaults
only. Local overrides use `.env.{mud}.local` and are ignored by git.

Copy an example before adding credentials:

```bash
cp .env.aardwolf.example .env.aardwolf.local
```

Edit the local file:

```env
ENABLED=true
HOST=aardmud.org
PORT=4000
USERNAME=your_username
PASSWORD=your_password
CHARACTER=YourCharacter
EXPECT_GMCP=true
EXPECT_MCCP=true
EXPECT_MXP=false
EXPECT_MSDP=false
EXPECT_UTF8=true
EXPECT_ANSI=true
TIMEOUT_MS=30000
LOGIN_PROMPT="Enter your username:"
```

## How It Works

1. Each test file automatically starts the proxy on port 6299.
2. Tests run in isolation with their own proxy instance.
3. The proxy is stopped after each test file completes.
4. Tests use `ws://`, not `wss://`, to avoid certificate issues.

## Environment Variables

- `WS_PORT` - WebSocket proxy port (default: 6200, test: 6299)
- `TN_HOST` - Default telnet host
- `TN_PORT` - Default telnet port
- `HOST` - Real MUD host for the selected E2E profile
- `PORT` - Real MUD port for the selected E2E profile
- `ENABLED` - Set to `true` to run a real MUD profile

## Troubleshooting

### Tests timeout

- Increase `TIMEOUT_MS` in your local env file.
- Check whether the MUD server is reachable.

### "E2E tests disabled"

- Create the `.env.{mud}.local` file.
- Set `ENABLED=true` in the local file.
- Ensure all required fields are set.

### Connection failed

- Check if proxy started. Logs will show `[E2E] Proxy started`.
- Verify `HOST` and `PORT` are correct.
- Check firewall/proxy settings.

## Adding New MUDs

1. Create config: `.env.your-mud.example`.
2. Create optional local override: `.env.your-mud.local`.
3. Create test: `tests/e2e/your-mud.test.ts`.
4. Add a package script that loads example first, then local override.
