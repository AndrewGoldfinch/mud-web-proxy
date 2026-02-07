# E2E Test Setup

## Overview

The E2E tests automatically start a test proxy server on port 6299, so you don't need to manually start the proxy.

## Running Tests

### Run all E2E tests:

```bash
bun run test:e2e
```

### Run specific MUD tests:

```bash
bun run test:e2e:aardwolf
bun run test:e2e:rom
bun run test:e2e:discworld
bun run test:e2e:ire
bun run test:e2e:raw
```

## Configuration

1. Copy the example config:

```bash
cp config/e2e.example.json config/e2e/aardwolf.json
```

2. Edit with your credentials:

```json
{
  "enabled": true,
  "host": "aardmud.org",
  "port": 4000,
  "username": "your_username",
  "password": "your_password",
  "expectations": {
    "gmcp": true,
    "mccp": true,
    "mxp": false,
    "msdp": false,
    "utf8": true,
    "ansi": true
  }
}
```

## How It Works

1. **Auto-start**: Each test file automatically starts the proxy on port 6299
2. **Isolation**: Tests run in isolation with their own proxy instance
3. **Cleanup**: Proxy is stopped after each test file completes
4. **TLS**: Self-signed certificates are accepted automatically

## Environment Variables

- `WS_PORT` - WebSocket proxy port (default: 6200, test: 6299)
- `TN_HOST` - Default telnet host
- `TN_PORT` - Default telnet port
- `NODE_TLS_REJECT_UNAUTHORIZED=0` - Disable TLS verification for testing

## Troubleshooting

### Tests timeout

- Increase `testTimeoutMs` in your config file
- Check if MUD server is reachable

### "Config file not found"

- Create the config file in `config/e2e/`

### Connection failed

- Check if proxy started (logs will show "[E2E] Proxy started")
- Verify TLS certificates exist

## Adding New MUDs

1. Create config: `config/e2e/your-mud.json`
2. Create test: `tests/e2e/your-mud.test.ts`
3. Add script to `package.json`
