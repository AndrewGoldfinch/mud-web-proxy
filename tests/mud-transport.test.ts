import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import {
  connectMudTransport,
  type ConnectedMudTransport,
} from '../src/mud-transport.js';
import type { TelnetSocket } from '../src/types/index.js';

class TestSocket extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

const originalCreateConnection = net.createConnection;
const originalTlsConnect = tls.connect;

afterEach(() => {
  net.createConnection = originalCreateConnection;
  tls.connect = originalTlsConnect;
});

const asTelnetSocket = (socket: TestSocket): TelnetSocket =>
  socket as unknown as TelnetSocket;

describe('connectMudTransport success paths', () => {
  test('plain connects over TCP and hands off the emitted socket', async () => {
    const socket = new TestSocket();
    const plainCalls: Array<[number, string]> = [];
    let tlsCalls = 0;
    net.createConnection = ((port: number, host: string) => {
      plainCalls.push([port, host]);
      return asTelnetSocket(socket);
    }) as typeof net.createConnection;
    tls.connect = ((
      _port: number,
      _host: string,
      _options: tls.ConnectionOptions,
    ) => {
      tlsCalls++;
      return asTelnetSocket(new TestSocket());
    }) as typeof tls.connect;

    const controller = new AbortController();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];

    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'plain',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: (connection) => connected.push(connection),
    });

    expect(plainCalls).toEqual([[4000, '203.0.113.7']]);
    expect(tlsCalls).toBe(0);
    expect(downgrades).toEqual([]);

    socket.emit('connect');
    await pending;

    expect(connected).toHaveLength(1);
    expect(connected[0]?.socket).toBe(asTelnetSocket(socket));
    expect(connected[0]).toEqual({
      socket: asTelnetSocket(socket),
      transport: 'plain',
      downgraded: false,
    });
  });

  test('prefer waits for a secure TLS connection before handoff', async () => {
    const socket = new TestSocket();
    let plainCalls = 0;
    let tlsCalls = 0;
    net.createConnection = ((_port: number, _host: string) => {
      plainCalls++;
      return asTelnetSocket(new TestSocket());
    }) as typeof net.createConnection;
    tls.connect = ((
      _port: number,
      _host: string,
      _options: tls.ConnectionOptions,
    ) => {
      tlsCalls++;
      return asTelnetSocket(socket);
    }) as typeof tls.connect;

    const controller = new AbortController();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];

    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'prefer',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: (connection) => connected.push(connection),
    });

    expect(plainCalls).toBe(0);
    expect(tlsCalls).toBe(1);
    expect(connected).toEqual([]);
    expect(downgrades).toEqual([]);

    socket.emit('secureConnect');
    await pending;

    expect(connected).toHaveLength(1);
    expect(connected[0]?.socket).toBe(asTelnetSocket(socket));
    expect(connected[0]).toEqual({
      socket: asTelnetSocket(socket),
      transport: 'tls',
      downgraded: false,
    });
  });

  test('TLS dials the validated address and sends SNI for the requested host', async () => {
    const socket = new TestSocket();
    const tlsCalls: Array<[number, string, tls.ConnectionOptions]> = [];
    tls.connect = ((
      port: number,
      host: string,
      options: tls.ConnectionOptions,
    ) => {
      tlsCalls.push([port, host, options]);
      return asTelnetSocket(socket);
    }) as typeof tls.connect;

    const controller = new AbortController();
    const connected: ConnectedMudTransport[] = [];
    const downgrades: string[] = [];

    const pending = connectMudTransport({
      requestedHost: 'mud.example',
      dialAddress: '203.0.113.7',
      port: 4000,
      mode: 'prefer',
      signal: controller.signal,
      onDowngrade: (reason) => downgrades.push(reason),
      onConnected: (connection) => connected.push(connection),
    });

    expect(tlsCalls).toEqual([
      [4000, '203.0.113.7', { servername: 'mud.example' }],
    ]);

    socket.emit('secureConnect');
    await pending;
    expect(connected).toHaveLength(1);
    expect(downgrades).toEqual([]);
  });
});
