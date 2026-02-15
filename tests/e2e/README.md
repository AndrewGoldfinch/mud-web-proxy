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
| Achaea     | `achaea.test.ts`     | GMCP             |
| ROM MUD    | `rom-mud.test.ts`    | Basic telnet     |
| Discworld  | `discworld.test.ts`  | MXP              |
| IRE MUD    | `ire-mud.test.ts`    | Heavy GMCP       |
| Raw Telnet | `raw-telnet.test.ts` | Port 23          |

## Setup

### 1. Create Environment Config Files

Each MUD has its own `.env.{mud}` file for configuration. Bun automatically loads these files.

**Create your local config (for secrets):**

```bash
# Copy the example and customize
cp .env.aardwolf .env.aardwolf.local
cp .env.achaea .env.achaea.local
cp .env.discworld .env.discworld.local
cp .env.ire .env.ire.local
cp .env.rom .env.rom.local
cp .env.raw .env.raw.local
```

**Note:** `.env.{mud}.local` files are gitignored for security - never commit credentials!

### 2. Configure Each MUD

Edit each `.env.{mud}.local` file with your credentials. Since each file is MUD-specific, variables don't need prefixes:

**.env.aardwolf.local:**

```env
# Enable this MUD for testing
ENABLED=true

# Connection settings
HOST=aardmud.org
PORT=4000

# Authentication (add to .env.aardwolf.local, not this file!)
USERNAME=your_username
PASSWORD=your_password
CHARACTER=YourCharacter

# Protocol expectations
EXPECT_GMCP=true
EXPECT_MCCP=true
EXPECT_MXP=false
EXPECT_MSDP=false
EXPECT_UTF8=true
EXPECT_ANSI=true

# Test settings
TIMEOUT_MS=30000
LOGIN_PROMPT="Enter your username:"
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

- Environment variable `ENABLED` is not set or is `false`
- Missing required fields (`HOST`, `PORT`)

You'll see a message like:

```
❌ Skipping Aardwolf E2E tests: E2E tests disabled (ENABLED not set or false). Create .env.aardwolf.local to enable.
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

Since each MUD has its own `.env.{mud}` file, variables don't need prefixes:

| Variable       | Required | Description                                   |
| -------------- | -------- | --------------------------------------------- |
| `ENABLED`      | Yes      | Set to `true` to run tests                    |
| `HOST`         | Yes      | MUD server hostname                           |
| `PORT`         | Yes      | MUD server port                               |
| `USERNAME`     | No       | Your MUD username                             |
| `PASSWORD`     | No       | Your MUD password                             |
| `CHARACTER`    | No       | Character name                                |
| `EXPECT_GMCP`  | Yes      | Expect GMCP support                           |
| `EXPECT_MCCP`  | Yes      | Expect MCCP support                           |
| `EXPECT_MXP`   | Yes      | Expect MXP support                            |
| `EXPECT_MSDP`  | Yes      | Expect MSDP support                           |
| `EXPECT_UTF8`  | Yes      | Expect UTF-8 support                          |
| `EXPECT_ANSI`  | Yes      | Expect ANSI color support                     |
| `TIMEOUT_MS`   | No       | Test timeout in milliseconds (default: 30000) |
| `LOGIN_PROMPT` | No       | Text to wait for at login                     |

## Security Notes

- `.env.{mud}.local` files are in `.gitignore` - **never commit credentials**
- Passwords are only used for testing, not stored
- Tests only verify connection/auth flow, not gameplay
- Credentials pass through to MUD servers directly

## Troubleshooting

### Tests timeout

- Increase `TIMEOUT_MS` in config
- Check proxy is running: `bun dev`
- Verify MUD server is reachable

### "E2E tests disabled"

- Create the `.env.{mud}.local` file
- Set `ENABLED=true` in the file
- Ensure all required fields are set

### "Connection failed"

- Check proxy is running on correct port
- Verify `HOST` and `PORT` are correct
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
5. Create config: `.env.your-mud` and `.env.your-mud.local`
6. Add npm script to `package.json`

Example `.env.your-mud`:

```env
ENABLED=true
HOST=your-mud.com
PORT=4000
EXPECT_GMCP=true
EXPECT_MCCP=false
EXPECT_MXP=true
EXPECT_MSDP=false
EXPECT_UTF8=true
EXPECT_ANSI=true
TIMEOUT_MS=30000
LOGIN_PROMPT="Login:"
```

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

## Migration from Prefixed Format

If you were using the old prefixed format (e.g., `AARDWOLF_ENABLED`), simply remove the prefixes:

**Old format:**

```env
AARDWOLF_ENABLED=true
AARDWOLF_HOST=aardmud.org
AARDWOLF_PORT=4000
```

**New format:**

```env
ENABLED=true
HOST=aardmud.org
PORT=4000
```

Since each MUD has its own `.env.{mud}` file, the prefix is unnecessary and redundant.
