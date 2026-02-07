# Mock MUD Server for E2E Testing

## Overview

A comprehensive mock MUD server that simulates various MUD types and protocols for fast, reliable E2E testing.

## Features

- **Protocol Support:** GMCP, MCCP, MXP, MSDP, NAWS, ANSI, UTF-8
- **Multiple MUD Types:** IRE, Aardwolf, Discworld, ROM, Generic
- **Chaos Mode:** Simulate network issues, delays, corruption
- **No External Dependencies:** Runs entirely in-memory
- **Fast:** No network latency

## Supported Protocols

| Protocol | Description | Supported |
|----------|-------------|-----------|
| **GMCP** | Generic MUD Communication Protocol | ✅ Yes |
| **MCCP** | MUD Client Compression Protocol | ✅ Yes |
| **MXP** | MUD eXtension Protocol | ✅ Yes |
| **MSDP** | MUD Server Data Protocol | ✅ Yes |
| **NAWS** | Negotiate About Window Size | ✅ Yes |
| **ANSI** | Color codes | ✅ Yes |
| **UTF-8** | Unicode support | ✅ Yes |

## Usage

### Run Mock MUD Server (CLI)

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

### Programmatic Usage

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

### MUD Types

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

**Chaos Mode** (`createChaosMUD()`)
- Port: 6305
- All protocols enabled
- Random delays (50-500ms)
- 5% packet loss
- 1% connection drops
- Data corruption

## Chaos Mode

Simulates real-world network issues:

```typescript
const chaosServer = createChaosMUD();

// Configurable chaos:
chaosServer = new MockMUDServer({
  chaos: {
    enabled: true,
    packetLoss: 0.05,      // 5% packets dropped
    delay: { min: 50, max: 500 }, // Random delays
    corruptData: true,     // Random corruption
    dropConnection: 0.01,  // 1% chance to disconnect
    malformedPackets: true, // Send bad data
  },
});
```

## E2E Test Integration

### Option C: Use Mock in CI, Real in Dev

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

### Environment Variables

```bash
# Force mock mode
export USE_MOCK_MUD=1

# Force real MUD mode
export USE_MOCK_MUD=0

# Auto-detect (default: mock in CI, real in dev)
# Detects CI=true, GITHUB_ACTIONS, etc.
```

## Testing Scenarios

### 1. Protocol Negotiation

```typescript
it('should negotiate GMCP', async () => {
  const server = createIREMUD();
  await server.start();
  
  // Connect and verify GMCP negotiation
  // ...
  
  await server.stop();
});
```

### 2. Login Flow

```typescript
it('should complete login', async () => {
  // Mock server accepts any username/password
  // Returns welcome message
  // Sends GMCP Char.Vitals
});
```

### 3. Command Handling

```typescript
it('should handle commands', async () => {
  // Send 'look'
  // Receive room description
  // Check ANSI codes present
});
```

### 4. Compression (MCCP)

```typescript
it('should use MCCP', async () => {
  // Server compresses all data
  // Client decompresses correctly
  // No errors in protocol handling
});
```

### 5. Chaos Mode

```typescript
it('should handle errors gracefully', async () => {
  const chaos = createChaosMUD();
  
  // Run multiple connections
  // Some will fail, some succeed
  // Verify error handling works
});
```

## Benefits

| Benefit | Description |
|---------|-------------|
| **Fast** | No network latency, instant responses |
| **Reliable** | 100% uptime, predictable behavior |
| **Isolated** | No external dependencies |
| **Reproducible** | Same results every time |
| **CI-Friendly** | Works in any CI environment |
| **Debuggable** | Full control over server state |
| **Protocol Testing** | Can inject errors, test edge cases |

## Comparison

| Feature | Mock MUD | Real MUD |
|---------|----------|----------|
| Speed | ⚡ Instant | 🐌 Network latency |
| Reliability | ✅ 100% | ❌ May be down |
| Realism | ❌ Simulated | ✅ Real |
| Error Injection | ✅ Easy | ❌ Hard |
| CI/CD | ✅ Works | ❌ Needs network |
| Debugging | ✅ Full control | ❌ Limited |
| Cost | Free | May require account |

## File Structure

```
tests/e2e/
├── mock-mud.ts           # Main mock server
├── mock-mud-helper.ts    # Test helpers
├── mock-mud.test.ts      # Sample tests
└── README.md             # This file
```

## Extending

Add new MUD type:

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

## Testing Tips

1. **Use chaos mode** to find edge cases
2. **Test protocol negotiation** thoroughly
3. **Verify data integrity** after compression
4. **Check error handling** with malformed data
5. **Test reconnection** scenarios

## License

Same as main project (GPL-3.0)
