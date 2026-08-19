# Mock MUD server for end-to-end testing

## Overview

The mock MUD server simulates several MUD types and their protocols, so that
end-to-end (E2E) tests run quickly and produce the same result every time.

## Features

- **Protocol support**: GMCP, MCCP, MXP, MSDP, NAWS, ANSI, and UTF-8.
- **Multiple MUD types**: IRE, Aardwolf, Discworld, ROM, and generic.
- **Chaos mode**: simulates network problems, delays, and corruption.
- **No external dependencies**: runs entirely in memory.
- **No network latency**: every response is local.

## Supported protocols

| Protocol | Description                        | Supported |
| -------- | ---------------------------------- | --------- |
| GMCP     | Generic MUD Communication Protocol | Yes       |
| MCCP     | MUD Client Compression Protocol    | Yes       |
| MXP      | MUD eXtension Protocol             | Yes       |
| MSDP     | MUD Server Data Protocol           | Yes       |
| NAWS     | Negotiate About Window Size        | Yes       |
| ANSI     | Color codes                        | Yes       |
| UTF-8    | Unicode support                    | Yes       |

## Usage

### Run the mock server from the command line

```bash
# Start default mock server (IRE type, port 6300)
bun tests/e2e/mock-mud.ts

# Start specific MUD type
bun tests/e2e/mock-mud.ts 6300 ire
bun tests/e2e/mock-mud.ts 6301 aardwolf
bun tests/e2e/mock-mud.ts 6302 discworld
bun tests/e2e/mock-mud.ts 6303 rom
bun tests/e2e/mock-mud.ts 6304 chaos
```

### Run the mock server from a test

The following code starts a server, uses it, and stops it again:

```typescript
import {
  MockMUDServer,
  createIREMUD,
  createAardwolfMUD,
  createChaosMUD,
} from './tests/e2e/mock-mud';

// Create server
const server = createIREMUD();

// Start it
await server.start();

// Use in tests...

// Stop it
await server.stop();
```

### MUD types

**IRE MUD** (`createIREMUD()`)

- Port: 6301
- Heavy GMCP with Char.Vitals
- MCCP compression
- ANSI colors

**Aardwolf** (`createAardwolfMUD()`)

- Port: 6302
- GMCP with room info
- MCCP compression
- ANSI colors
- Custom prompts

**Discworld** (`createDiscworldMUD()`)

- Port: 6303
- MXP support
- ANSI colors

**ROM MUD** (`createROMMUD()`)

- Port: 6304
- Basic telnet only
- ANSI colors

**Chaos mode** (`createChaosMUD()`)

- Port: 6305
- All protocols enabled
- Random delays of 50 ms to 500 ms
- 5% packet loss
- 1% connection drops
- Data corruption

## Chaos mode

Chaos mode simulates real-world network problems:

```typescript
const chaosServer = createChaosMUD();

// Configurable chaos:
chaosServer = new MockMUDServer({
  chaos: {
    enabled: true,
    packetLoss: 0.05, // 5% packets dropped
    delay: { min: 50, max: 500 }, // Random delays
    corruptData: true, // Random corruption
    dropConnection: 0.01, // 1% chance to disconnect
    malformedPackets: true, // Send bad data
  },
});
```

## E2E test integration

### Use the mock in CI and a real MUD in development

```typescript
import { shouldUseMockMUD, startMockMUDTest } from './mock-mud-helper';

describe('My MUD Tests', () => {
  let setup: MockMUDSetup;

  beforeAll(async () => {
    if (shouldUseMockMUD()) {
      // Use mock server (CI mode)
      setup = await startMockMUDTest('ire', 6299);
    } else {
      // Use real MUD (dev mode) - your existing setup
      setup = await startRealMUDTest();
    }
  });
});
```

### Environment variables

```bash
# Force mock mode
export USE_MOCK_MUD=1

# Force real MUD mode
export USE_MOCK_MUD=0

# Auto-detect (default: mock in CI, real in dev)
# Detects CI=true, GITHUB_ACTIONS, and similar variables.
```

## Testing scenarios

### Protocol negotiation

```typescript
it('should negotiate GMCP', async () => {
  const server = createIREMUD();
  await server.start();

  // Connect and verify GMCP negotiation
  // ...

  await server.stop();
});
```

### Login flow

```typescript
it('should complete login', async () => {
  // Mock server accepts any username/password
  // Returns welcome message
  // Sends GMCP Char.Vitals
});
```

### Command handling

```typescript
it('should handle commands', async () => {
  // Send 'look'
  // Receive room description
  // Check ANSI codes present
});
```

### Compression (MCCP)

The mock offers `IAC WILL MCCP2`, but the proxy declines it. MWP-128 removed an
unreachable negotiation branch rather than wiring it up, so refusal is the
decided behavior on both wire protocols.

Don't try to assert that refusal from an E2E test here. This suite drives the
typed protocol, which goes through the session stack's `TelnetParser`; the
legacy `sendClient` path is never exercised, so an E2E assertion stays green
even if legacy MCCP is reintroduced. That mistake was made and reverted while
writing MWP-128.

The refusal is pinned where it can actually fail, in the
`tests/telnet-mccp-declined.test.ts` file, by feeding the parser a real offer
and asserting that no `IAC DO MCCP2` goes back, with controls proving that the
harness records replies for other options.

### Chaos mode under load

```typescript
it('should handle errors gracefully', async () => {
  const chaos = createChaosMUD();

  // Run multiple connections
  // Some will fail, some succeed
  // Verify error handling works
});
```

## Benefits

| Benefit          | Description                               |
| ---------------- | ----------------------------------------- |
| Speed            | No network latency, instant responses     |
| Reliability      | No external outage, predictable behavior  |
| Isolation        | No external dependencies                  |
| Reproducibility  | Same results every time                   |
| CI compatibility | Runs in any CI environment                |
| Debuggability    | Full control over server state            |
| Protocol testing | Can inject errors and exercise edge cases |

## Comparison

| Feature         | Mock MUD     | Real MUD               |
| --------------- | ------------ | ---------------------- |
| Speed           | Instant      | Network latency        |
| Reliability     | No outages   | Can be down            |
| Realism         | Simulated    | Real                   |
| Error injection | Built in     | Not available          |
| CI/CD           | Runs offline | Needs network          |
| Debugging       | Full control | Limited                |
| Cost            | Free         | Can require an account |

## File structure

```
tests/e2e/
├── mock-mud.ts           # Main mock server
├── mock-mud-helper.ts    # Test helpers
├── proxy-launcher.ts     # Proxy lifecycle management
├── connection-helper.ts  # WebSocket connection helpers
├── config-loader.ts      # Test config loading
├── run-mock-tests.ts     # Mock test runner
├── mock-mud.test.ts      # Mock MUD tests
├── aardwolf.test.ts      # Aardwolf E2E tests
├── achaea.test.ts        # Achaea E2E tests (GMCP)
├── discworld.test.ts     # Discworld E2E tests (MXP)
├── ire-mud.test.ts       # IRE MUD E2E tests
├── rom-mud.test.ts       # ROM MUD E2E tests
├── raw-telnet.test.ts    # Raw telnet E2E tests
├── README.md             # E2E test documentation
└── SETUP.md              # Setup guide
```

## Configuration through environment variables

Tests read configuration from `.env` files rather than from JSON. For details,
see the `tests/e2e/README.md` file.

```bash
# Example .env.aardwolf.local
AARDWOLF_ENABLED=true
AARDWOLF_HOST=localhost
AARDWOLF_PORT=6300
AARDWOLF_EXPECT_GMCP=true
AARDWOLF_EXPECT_MCCP=true
```

## Extend the mock server

The following code adds a MUD type:

```typescript
export function createMyMUD(): MockMUDServer {
  return new MockMUDServer({
    name: 'My Custom MUD',
    type: 'custom',
    port: 6306,
    supports: {
      gmcp: true,
      mccp: false,
      mxp: true,
      msdp: false,
      ansi: true,
      utf8: true,
    },
    responses: {
      loginPrompt: 'Who are you? ',
      passwordPrompt: 'Secret word: ',
      welcomeMessage: 'Welcome!\n',
      roomDescription: 'A room.\n',
      prompt: '> ',
    },
    gmcp: {
      charVitals: { hp: 100, maxhp: 100 },
    },
  });
}
```

## Testing tips

- Use chaos mode to find edge cases.
- Test protocol negotiation thoroughly.
- Verify data integrity after compression.
- Check error handling with malformed data.
- Test reconnection scenarios.

## License

This mock server is covered by the project license,
[GPL-3.0-or-later](../LICENSE).
