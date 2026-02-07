/**
 * Mock MUD Server for E2E Testing
 * Simulates various MUD behaviors and protocols
 * Supports: GMCP, MCCP, MXP, MSDP, ANSI, UTF-8
 * Chaos mode for stress testing
 */

import net from 'net';
import zlib from 'zlib';
import { EventEmitter } from 'events';

// Telnet IAC codes
const IAC = 0xff;
const DONT = 0xfe;
const DO = 0xfd;
const WONT = 0xfc;
const WILL = 0xfb;
const SB = 0xfa;
const SE = 0xf0;
const IS = 0x00;
const SEND = 0x01;
const GA = 0xf9;

// Protocol options
const OPT_ECHO = 0x01;
const OPT_SUPPRESS_GO_AHEAD = 0x03;
const OPT_STATUS = 0x05;
const OPT_TIMING_MARK = 0x06;
const OPT_TERMINAL_TYPE = 0x18;
const OPT_EOR = 0x19;
const OPT_NAWS = 0x1f;
const OPT_LINEMODE = 0x22;
const OPT_NEW_ENVIRON = 0x27;
const OPT_CHARSET = 0x2a;
const OPT_MSDP = 0x45;
const OPT_MSSP = 0x46;
const OPT_MCCP2 = 0x56;
const OPT_MCCP = 0x56; // MCCP v2
const OPT_MSP = 0x57;
const OPT_MXP = 0x5b;
const OPT_GMCP = 0xc9;

export interface MockMUDConfig {
  port: number;
  name: string;
  type: 'ire' | 'rom' | 'aardwolf' | 'discworld' | 'generic';
  supports: {
    gmcp: boolean;
    mccp: boolean;
    mxp: boolean;
    msdp: boolean;
    ansi: boolean;
    utf8: boolean;
  };
  chaos?: {
    enabled: boolean;
    packetLoss: number; // 0-1 probability
    delay: { min: number; max: number }; // ms
    corruptData: boolean;
    dropConnection: number; // 0-1 probability
    malformedPackets: boolean;
  };
  responses: {
    loginPrompt: string;
    passwordPrompt: string;
    welcomeMessage: string;
    roomDescription: string;
    prompt: string;
  };
  gmcp?: {
    charVitals: object;
    charStats: object;
    roomInfo: object;
    commChannel: object;
  };
}

export interface MockClient {
  socket: net.Socket;
  id: string;
  negotiated: Set<number>;
  compressing: boolean;
  compressStream: zlib.DeflateRaw | null;
  authenticated: boolean;
  username?: string;
  character?: string;
  windowWidth: number;
  windowHeight: number;
}

export class MockMUDServer extends EventEmitter {
  private server: net.Server | null = null;
  private clients: Map<string, MockClient> = new Map();
  private config: MockMUDConfig;
  private running = false;

  constructor(config: Partial<MockMUDConfig> = {}) {
    super();
    this.config = {
      port: 6300,
      name: 'Mock MUD',
      type: 'generic',
      supports: {
        gmcp: true,
        mccp: true,
        mxp: false,
        msdp: false,
        ansi: true,
        utf8: true,
      },
      chaos: {
        enabled: false,
        packetLoss: 0,
        delay: { min: 0, max: 0 },
        corruptData: false,
        dropConnection: 0,
        malformedPackets: false,
      },
      responses: {
        loginPrompt: 'Enter your username: ',
        passwordPrompt: 'Password: ',
        welcomeMessage: 'Welcome to the Mock MUD!\r\n',
        roomDescription: 'You are in a generic room.\r\n',
        prompt: '> ',
      },
      gmcp: {
        charVitals: {
          hp: 100,
          maxhp: 100,
          mp: 100,
          maxmp: 100,
          ep: 100,
          maxep: 100,
          wp: 100,
          maxwp: 100,
        },
        charStats: {
          name: 'TestCharacter',
          level: 1,
        },
        roomInfo: {
          num: 1,
          name: 'A Generic Room',
          area: 'Test Area',
          environment: 'indoor',
        },
        commChannel: {
          chan: 'tell',
          msg: 'Hello from test!',
          player: 'TestPlayer',
        },
      },
      ...config,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.config.port, () => {
        this.running = true;
        console.log(`[MockMUD] Server "${this.config.name}" listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const client of this.clients.values()) {
        client.socket.end();
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          this.running = false;
          console.log('[MockMUD] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: net.Socket): void {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[MockMUD] Client connected: ${clientId}`);

    const client: MockClient = {
      socket,
      id: clientId,
      negotiated: new Set(),
      compressing: false,
      compressStream: null,
      authenticated: false,
      windowWidth: 80,
      windowHeight: 24,
    };

    this.clients.set(clientId, client);
    this.emit('connect', client);

    socket.on('data', async (data) => {
      try {
        await this.handleData(client, data);
      } catch (err) {
        console.error('[MockMUD] Error handling data:', err);
      }
    });

    socket.on('close', () => {
      console.log(`[MockMUD] Client disconnected: ${clientId}`);
      this.clients.delete(clientId);
      this.emit('disconnect', client);
    });

    socket.on('error', (err) => {
      console.error(`[MockMUD] Socket error for ${clientId}:`, err.message);
    });
  }

  private async handleData(client: MockClient, data: Buffer): Promise<void> {
    // Chaos mode: Simulate packet loss
    if (this.config.chaos?.enabled && this.config.chaos.packetLoss > 0) {
      if (Math.random() < this.config.chaos.packetLoss) {
        console.log('[MockMUD Chaos] Dropping packet');
        return;
      }
    }

    // Chaos mode: Simulate delay
    if (this.config.chaos?.enabled && this.config.chaos.delay.max > 0) {
      const delay = Math.floor(
        Math.random() * (this.config.chaos.delay.max - this.config.chaos.delay.min) +
        this.config.chaos.delay.min
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Chaos mode: Corrupt data
    if (this.config.chaos?.enabled && this.config.chaos.corruptData) {
      if (Math.random() < 0.1) {
        console.log('[MockMUD Chaos] Corrupting data');
        for (let i = 0; i < data.length; i += 10) {
          data[i] = Math.floor(Math.random() * 256);
        }
      }
    }

    // Process telnet commands
    let i = 0;
    while (i < data.length) {
      if (data[i] === IAC) {
        // Telnet command
        if (i + 2 < data.length) {
          await this.handleTelnetCommand(client, data, i);
          i += 3;
        } else {
          break;
        }
      } else {
        // Regular text data
        const textStart = i;
        while (i < data.length && data[i] !== IAC) {
          i++;
        }
        const text = data.slice(textStart, i).toString('utf8');
        if (text.trim()) {
          await this.handleText(client, text);
        }
      }
    }
  }

  private async handleTelnetCommand(
    client: MockClient,
    data: Buffer,
    offset: number,
  ): Promise<void> {
    const cmd = data[offset + 1];
    const opt = data[offset + 2];

    console.log(`[MockMUD] Telnet: ${cmd.toString(16)} ${opt.toString(16)}`);

    if (cmd === DO) {
      // Client wants us to enable option
      if (this.shouldSupport(opt)) {
        client.negotiated.add(opt);
        this.sendIAC(client, WILL, opt);

        // Handle specific options
        if (opt === OPT_MCCP2 && this.config.supports.mccp) {
          await this.enableMCCP(client);
        } else if (opt === OPT_GMCP && this.config.supports.gmcp) {
          await this.sendGMCP(client, 'Core.Hello', {
            version: '1.0',
            client: 'MockMUD',
          });
          // Send char vitals
          await this.sendGMCP(client, 'Char.Vitals', this.config.gmcp?.charVitals);
        } else if (opt === OPT_MXP && this.config.supports.mxp) {
          await this.sendMXP(client);
        }
      } else {
        this.sendIAC(client, WONT, opt);
      }
    } else if (cmd === WILL) {
      // Client will enable option
      client.negotiated.add(opt);
      this.sendIAC(client, DO, opt);
    } else if (cmd === SB) {
      // Subnegotiation
      await this.handleSubnegotiation(client, data, offset);
    }
  }

  private async handleSubnegotiation(
    client: MockClient,
    data: Buffer,
    offset: number,
  ): Promise<void> {
    const opt = data[offset + 2];

    // Find SE
    let end = offset + 3;
    while (end < data.length) {
      if (data[end] === IAC && end + 1 < data.length && data[end + 1] === SE) {
        break;
      }
      end++;
    }

    const subData = data.slice(offset + 3, end);

    if (opt === OPT_NAWS && subData.length >= 4) {
      // Window size
      client.windowWidth = (subData[0] << 8) | subData[1];
      client.windowHeight = (subData[2] << 8) | subData[3];
      console.log(`[MockMUD] Window size: ${client.windowWidth}x${client.windowHeight}`);
    } else if (opt === OPT_GMCP && this.config.supports.gmcp) {
      // GMCP data from client
      const gmcpData = subData.toString('utf8');
      console.log('[MockMUD] GMCP received:', gmcpData);
      await this.handleGMCP(client, gmcpData);
    }
  }

  private async handleGMCP(client: MockClient, data: string): Promise<void> {
    // Parse GMCP package
    const spaceIndex = data.indexOf(' ');
    const pkg = spaceIndex > 0 ? data.slice(0, spaceIndex) : data;
    const json = spaceIndex > 0 ? data.slice(spaceIndex + 1) : '{}';

    try {
      const parsed = JSON.parse(json);

      if (pkg === 'Core.Supports.Set') {
        // Client sent supported packages
        await this.sendGMCP(client, 'Char.Vitals', this.config.gmcp?.charVitals);
      } else if (pkg === 'Char.Login') {
        // Login attempt
        if (parsed.name && parsed.password) {
          client.username = parsed.name;
          await this.sendWelcome(client);
        }
      }
    } catch (e) {
      // Invalid JSON
      console.error('[MockMUD] Invalid GMCP JSON:', json);
    }
  }

  private async handleText(client: MockClient, text: string): Promise<void> {
    console.log(`[MockMUD] Received text: ${text.trim()}`);

    // Chaos mode: Drop connection randomly
    if (this.config.chaos?.enabled && this.config.chaos.dropConnection > 0) {
      if (Math.random() < this.config.chaos.dropConnection) {
        console.log('[MockMUD Chaos] Dropping connection');
        client.socket.destroy();
        return;
      }
    }

    if (!client.authenticated) {
      // Login flow
      if (!client.username) {
        client.username = text.trim();
        await this.sendText(client, this.config.responses.passwordPrompt);
      } else {
        // Password received
        client.authenticated = true;
        await this.sendWelcome(client);
      }
    } else {
      // Authenticated commands
      const cmd = text.trim().toLowerCase();

      if (cmd === 'look' || cmd === 'l') {
        await this.sendText(client, this.config.responses.roomDescription);
      } else if (cmd === 'quit' || cmd === 'q') {
        await this.sendText(client, 'Goodbye!\r\n');
        client.socket.end();
      } else {
        // Echo command back
        await this.sendText(client, `You typed: ${text.trim()}\r\n`);
      }

      // Send prompt
      await this.sendText(client, this.config.responses.prompt);
    }
  }

  private async sendWelcome(client: MockClient): Promise<void> {
    // Send welcome message
    await this.sendText(client, '\r\n' + this.config.responses.welcomeMessage);

    // Send GMCP data if negotiated
    if (client.negotiated.has(OPT_GMCP) && this.config.supports.gmcp) {
      await this.sendGMCP(client, 'Char.Vitals', this.config.gmcp?.charVitals);
      await this.sendGMCP(client, 'Char.Status', this.config.gmcp?.charStats);
      await this.sendGMCP(client, 'Room.Info', this.config.gmcp?.roomInfo);
    }

    // Send room description
    await this.sendText(client, this.config.responses.roomDescription);
    await this.sendText(client, this.config.responses.prompt);
  }

  private async sendText(client: MockClient, text: string): Promise<void> {
    let data = Buffer.from(text, 'utf8');

    // Apply MXP if negotiated
    if (client.negotiated.has(OPT_MXP) && this.config.supports.mxp) {
      data = this.applyMXP(data);
    }

    // Apply ANSI if supported
    if (this.config.supports.ansi) {
      data = this.applyANSI(data);
    }

    // Compress if MCCP is active
    if (client.compressing && client.compressStream) {
      client.compressStream.write(data);
      client.compressStream.flush();
    } else {
      client.socket.write(data);
    }
  }

  private sendIAC(client: MockClient, cmd: number, opt: number): void {
    const buf = Buffer.from([IAC, cmd, opt]);
    client.socket.write(buf);
  }

  private async enableMCCP(client: MockClient): Promise<void> {
    console.log('[MockMUD] Enabling MCCP compression');
    client.compressing = true;
    client.compressStream = zlib.createDeflateRaw({
      level: zlib.constants.Z_DEFAULT_COMPRESSION,
    });

    client.compressStream.on('data', (chunk: Buffer) => {
      client.socket.write(chunk);
    });

    // Send IAC SB MCCP IAC SE
    const buf = Buffer.from([IAC, SB, OPT_MCCP, IAC, SE]);
    client.socket.write(buf);
  }

  private async sendGMCP(
    client: MockClient,
    pkg: string,
    data: unknown,
  ): Promise<void> {
    if (!client.negotiated.has(OPT_GMCP) || !this.config.supports.gmcp) {
      return;
    }

    const json = JSON.stringify(data);
    const payload = `${pkg} ${json}`;
    const buf = Buffer.concat([
      Buffer.from([IAC, SB, OPT_GMCP]),
      Buffer.from(payload, 'utf8'),
      Buffer.from([IAC, SE]),
    ]);

    client.socket.write(buf);
  }

  private async sendMXP(client: MockClient): Promise<void> {
    if (!client.negotiated.has(OPT_MXP) || !this.config.supports.mxp) {
      return;
    }

    // Send MXP version
    const version = '<VERSION MXP=1.0>';
    const buf = Buffer.concat([
      Buffer.from([IAC, SB, OPT_MXP]),
      Buffer.from(version, 'utf8'),
      Buffer.from([IAC, SE]),
    ]);

    client.socket.write(buf);
  }

  private applyMXP(data: Buffer): Buffer {
    // Add some sample MXP tags
    let text = data.toString('utf8');
    text = text.replace(/room/gi, '<COLOR fore="green">room</COLOR>');
    text = text.replace(/test/gi, '<COLOR fore="cyan">test</COLOR>');
    return Buffer.from(text, 'utf8');
  }

  private applyANSI(data: Buffer): Buffer {
    // Add ANSI color codes
    let text = data.toString('utf8');
    text = text.replace(/welcome/gi, '\x1b[33mWelcome\x1b[0m');
    text = text.replace(/password:/gi, '\x1b[1;31mPassword:\x1b[0m');
    return Buffer.from(text, 'utf8');
  }

  private shouldSupport(opt: number): boolean {
    switch (opt) {
      case OPT_ECHO:
      case OPT_SUPPRESS_GO_AHEAD:
      case OPT_TERMINAL_TYPE:
      case OPT_NAWS:
      case OPT_CHARSET:
        return true;
      case OPT_GMCP:
        return this.config.supports.gmcp;
      case OPT_MCCP2:
        return this.config.supports.mccp;
      case OPT_MXP:
        return this.config.supports.mxp;
      case OPT_MSDP:
        return this.config.supports.msdp;
      default:
        return false;
    }
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getClientCount(): number {
    return this.clients.size;
  }
}

// Factory functions for different MUD types
export function createIREMUD(): MockMUDServer {
  return new MockMUDServer({
    name: 'Mock IRE MUD',
    type: 'ire',
    port: 6301,
    supports: {
      gmcp: true,
      mccp: true,
      mxp: false,
      msdp: false,
      ansi: true,
      utf8: true,
    },
    responses: {
      loginPrompt: 'Name: ',
      passwordPrompt: 'Password: ',
      welcomeMessage: '\nWelcome to the Iron Realms!\n\n',
      roomDescription: 'You stand in the Hall of the Mock IRE MUD.\n',
      prompt: '\n[100/100h 100/100m 100/100e]: ',
    },
    gmcp: {
      charVitals: {
        hp: 100,
        maxhp: 100,
        mp: 100,
        maxmp: 100,
        ep: 100,
        maxep: 100,
        wp: 100,
        maxwp: 100,
      },
      charStats: {
        name: 'TestPlayer',
        level: 80,
        class: 'TestClass',
      },
      roomInfo: {
        num: 1,
        name: 'Hall of the Mock',
        area: 'Test City',
        environment: 'urban',
        coords: '0,0,0',
      },
      commChannel: {
        chan: 'ct',
        msg: 'Hello city!',
        player: 'TestPlayer',
      },
    },
  });
}

export function createAardwolfMUD(): MockMUDServer {
  return new MockMUDServer({
    name: 'Mock Aardwolf',
    type: 'aardwolf',
    port: 6302,
    supports: {
      gmcp: true,
      mccp: true,
      mxp: false,
      msdp: false,
      ansi: true,
      utf8: true,
    },
    responses: {
      loginPrompt: 'Enter your username: ',
      passwordPrompt: 'Password: ',
      welcomeMessage: '\x1b[33mWelcome to Aardwolf!\x1b[0m\r\n\r\n',
      roomDescription: 'You are standing in a test room.\r\n',
      prompt: '\r\n\x1b[32m[100hp 100m 100mv]\x1b[0m > ',
    },
    gmcp: {
      charVitals: {
        hp: 100,
        maxhp: 100,
        mana: 100,
        maxmana: 100,
        moves: 100,
        maxmoves: 100,
        tnl: 1000,
      },
      charStats: {
        name: 'TestChar',
        level: 1,
        race: 'Human',
        class: 'Warrior',
      },
      roomInfo: {
        num: 1,
        name: 'The Test Room',
        area: 'Test Area',
      },
      commChannel: {
        type: 'tell',
        from: 'TestPlayer',
        msg: 'Hello!',
      },
    },
  });
}

export function createDiscworldMUD(): MockMUDServer {
  return new MockMUDServer({
    name: 'Mock Discworld',
    type: 'discworld',
    port: 6303,
    supports: {
      gmcp: false,
      mccp: false,
      mxp: true,
      msdp: false,
      ansi: true,
      utf8: true,
    },
    responses: {
      loginPrompt: 'Your name: ',
      passwordPrompt: 'Password: ',
      welcomeMessage: 'Welcome to Discworld!\n',
      roomDescription: 'You are in the Test Room on Discworld.\n',
      prompt: '> ',
    },
  });
}

export function createROMMUD(): MockMUDServer {
  return new MockMUDServer({
    name: 'Mock ROM MUD',
    type: 'rom',
    port: 6304,
    supports: {
      gmcp: false,
      mccp: false,
      mxp: false,
      msdp: false,
      ansi: true,
      utf8: true,
    },
    responses: {
      loginPrompt: 'Login: ',
      passwordPrompt: 'Password: ',
      welcomeMessage: '\nWelcome to ROM!\n\n',
      roomDescription: 'You are in a plain room.\n',
      prompt: '\n<100hp 100m 100mv> ',
    },
  });
}

export function createChaosMUD(): MockMUDServer {
  return new MockMUDServer({
    name: 'Mock Chaos MUD',
    type: 'generic',
    port: 6305,
    supports: {
      gmcp: true,
      mccp: true,
      mxp: true,
      msdp: true,
      ansi: true,
      utf8: true,
    },
    chaos: {
      enabled: true,
      packetLoss: 0.05, // 5% packet loss
      delay: { min: 50, max: 500 }, // 50-500ms delay
      corruptData: true,
      dropConnection: 0.01, // 1% chance to drop connection
      malformedPackets: true,
    },
    responses: {
      loginPrompt: 'Login: ',
      passwordPrompt: 'Password: ',
      welcomeMessage: 'Welcome to Chaos MUD!\n',
      roomDescription: 'Everything is unpredictable here.\n',
      prompt: '> ',
    },
  });
}

// Simple CLI for testing
if (import.meta.main) {
  const port = parseInt(process.argv[2] || '6300', 10);
  const type = process.argv[3] || 'ire';

  let server: MockMUDServer;

  switch (type) {
    case 'ire':
      server = createIREMUD();
      break;
    case 'aardwolf':
      server = createAardwolfMUD();
      break;
    case 'discworld':
      server = createDiscworldMUD();
      break;
    case 'rom':
      server = createROMMUD();
      break;
    case 'chaos':
      server = createChaosMUD();
      break;
    default:
      server = new MockMUDServer({ port, type: 'generic' });
  }

  await server.start();
  console.log(`Mock MUD running. Press Ctrl+C to stop.`);

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
}
