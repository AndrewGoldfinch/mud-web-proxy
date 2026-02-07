# E2E Tests for MUD Web Proxy

End-to-end tests against real MUD servers to verify protocol compatibility.

## Overview

These tests connect to actual MUD servers through the proxy to verify:

- Protocol negotiation (GMCP, MCCP, MXP, MSDP)
- Session management
- Buffer replay
- Data flow
- Authentication

### Automatic Proxy

**No manual setup needed!** Each test automatically:

1. Starts a test proxy on port 6299 (non-TLS mode)
2. Runs the tests
3. Stops the proxy when done

Tests use `ws://` (non-TLS) to avoid certificate issues.

## Supported MUDs

| MUD Type   | Test File            | Protocols        |
| ---------- | -------------------- | ---------------- |
| Aardwolf   | `aardwolf.test.ts`   | GMCP, MCCP, ANSI |
| ROM MUD    | `rom-mud.test.ts`    | Basic telnet     |
| Discworld  | `discworld.test.ts`  | MXP              |
| IRE MUD    | `ire-mud.test.ts`    | Heavy GMCP       |
| Raw Telnet | `raw-telnet.test.ts` | Port 23          |

## Setup

### 1. Create Config Files

Copy the example config and create your own:

```bash
cp config/e2e.example.json config/e2e/aardwolf.json
cp config/e2e.example.json config/e2e/rom-mud.json
cp config/e2e.example.json config/e2e/discworld.json
cp config/e2e.example.json config/e2e/ire-mud.json
cp config/e2e.example.json config/e2e/raw-telnet.json
```

### 2. Configure Each MUD

Edit each config file with your credentials:

**config/e2e/aardwolf.json:**

```json
{
  "enabled": true,
  "host": "aardmud.org",
  "port": 4000,
  "username": "your_username",
  "password": "your_password",
  "character": "YourCharacter",
  "expectations": {
    "gmcp": true,
    "mccp": true,
    "mxp": false,
    "msdp": false,
    "utf8": true,
    "ansi": true
  },
  "testTimeoutMs": 30000,
  "loginPrompt": "Enter your username:"
}
```

### 3. Start the Proxy

```bash
bun dev
```

### 4. Run Tests

**Run all E2E tests:**

```bash
bun run test:e2e
```

**Run specific MUD tests:**

```bash
bun run test:e2e:aardwolf
bun run test:e2e:rom
bun run test:e2e:discworld
bun run test:e2e:ire
bun run test:e2e:raw
```

## Test Behavior

### Skipped Tests

Tests are automatically skipped if:

- Config file doesn't exist
- `enabled` is set to `false` in config
- Missing required fields (host, port)

You'll see a message like:

```
❌ Skipping Aardwolf E2E tests: Config file not found: config/e2e/aardwolf.json
```

### What Tests Verify

**Aardwolf:**

- Session creation
- GMCP negotiation
- MCCP compression
- ANSI color support
- Login flow
- Session resume

**ROM MUD:**

- Basic telnet connection
- Login prompt detection
- No protocol errors
- Simple command handling

**Discworld:**

- MXP negotiation
- Login prompt
- MXP markup in output

**IRE MUD:**

- GMCP negotiation
- Heavy GMCP traffic handling
- Char package detection
- Error-free protocol handling

**Raw Telnet:**

- Port 23 connectivity
- Minimal protocol handling
- Clean disconnect

## Configuration Options

| Field           | Required | Description                                   |
| --------------- | -------- | --------------------------------------------- |
| `enabled`       | Yes      | Set to `true` to run tests                    |
| `host`          | Yes      | MUD server hostname                           |
| `port`          | Yes      | MUD server port                               |
| `username`      | No       | Your MUD username                             |
| `password`      | No       | Your MUD password                             |
| `character`     | No       | Character name                                |
| `expectations`  | Yes      | Protocol expectations (gmcp, mccp, etc.)      |
| `testTimeoutMs` | No       | Test timeout in milliseconds (default: 30000) |
| `loginPrompt`   | No       | Text to wait for at login                     |

## Security Notes

- Config files are in `.gitignore` - **never commit credentials**
- Passwords are only used for testing, not stored
- Tests only verify connection/auth flow, not gameplay
- Credentials pass through to MUD servers directly

## Troubleshooting

### Tests timeout

- Increase `testTimeoutMs` in config
- Check proxy is running: `bun dev`
- Verify MUD server is reachable

### "Config file not found"

- Create the config file in `config/e2e/`
- Ensure filename matches MUD name (e.g., `aardwolf.json`)

### "Connection failed"

- Check proxy is running on correct port
- Verify `E2E_PROXY_URL` environment variable
- Check firewall/proxy settings

### Protocol not negotiating

- Some MUDs require specific client settings
- Check MUD documentation for protocol requirements
- Verify proxy supports the protocol

## Adding New MUDs

1. Create new test file: `tests/e2e/your-mud.test.ts`
2. Copy template from existing test
3. Update `MUD_NAME` constant
4. Add tests for your MUD's specific features
5. Create config: `config/e2e/your-mud.json`
6. Add npm script to `package.json`

## CI/CD Integration

E2E tests are **not** run in CI by default. They require:

- Running proxy server
- Network access to MUD servers
- Valid credentials

To enable in CI, set environment variables and ensure proxy is running:

```yaml
- name: Run E2E tests
  run: |
    bun dev &
    sleep 5
    bun run test:e2e
  env:
    E2E_PROXY_URL: ws://localhost:6200
```
