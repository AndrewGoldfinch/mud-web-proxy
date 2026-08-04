// SPDX-License-Identifier: GPL-3.0-or-later

import net from 'net';
import tls from 'tls';
import type { MudTlsMode } from './runtime-config';
import type { TelnetSocket } from './types';
import { parseIPv4 } from './wsproxy-utils';

const TLS_HANDSHAKE_CLOSE =
  /socket disconnected before secure tls connection was established/;

const TLS_DIAGNOSTICS = [
  'wrong version number',
  'packet length',
  'unable to verify',
  'certificate',
  'ssl routines',
  'tls_process',
  'tlsv1',
  'sslv3',
  'alert handshake failure',
  'unsupported protocol',
  'no cipher',
  'decryption failed',
  'bad record mac',
];

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export type TlsFallbackTrigger = 'error' | 'close';
export type MudTransportKind = 'plain' | 'tls';

export interface ConnectedMudTransport {
  socket: TelnetSocket;
  transport: MudTransportKind;
  downgraded: boolean;
}

export interface MudTransportOptions {
  requestedHost: string;
  dialAddress: string;
  port: number;
  mode: MudTlsMode;
  signal: AbortSignal;
  onDowngrade: (reason: string) => void;
  onConnected: (connection: ConnectedMudTransport) => void;
}

export const isTlsNegotiationError = (err: Error): boolean => {
  const message = err.message.toLowerCase();
  if (TLS_HANDSHAKE_CLOSE.test(message)) return true;

  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSPORT_CODES.has(code)) return false;

  return TLS_DIAGNOSTICS.some((pattern) => message.includes(pattern));
};

export const shouldAttemptTls = (mode: MudTlsMode): boolean =>
  mode !== 'plain';

export const shouldFallBackToPlain = (
  mode: MudTlsMode,
  trigger: TlsFallbackTrigger,
  err?: Error,
): boolean => {
  if (mode !== 'prefer') return false;
  if (trigger === 'close') return true;
  return err ? isTlsNegotiationError(err) : false;
};

export const sniServerName = (host: string): string | undefined => {
  const bare = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (!host || parseIPv4(bare) || host.includes(':')) return undefined;
  return host;
};

export const connectMudTransport = (
  options: MudTransportOptions,
): Promise<void> => {
  return new Promise((resolve) => {
    let provisionalSocket: TelnetSocket | null = null;
    let settled = false;

    const onPlainConnect = (): void => {
      if (!provisionalSocket) return;
      handoff({
        socket: provisionalSocket,
        transport: 'plain',
        downgraded: false,
      });
    };
    const onTlsConnect = (): void => {
      if (!provisionalSocket) return;
      handoff({
        socket: provisionalSocket,
        transport: 'tls',
        downgraded: false,
      });
    };
    const removeConnectorListeners = (): void => {
      if (!provisionalSocket) return;
      provisionalSocket.off('connect', onPlainConnect);
      provisionalSocket.off('secureConnect', onTlsConnect);
    };
    const handoff = (connection: ConnectedMudTransport): void => {
      if (settled) return;
      settled = true;
      removeConnectorListeners();
      options.onConnected(connection);
      resolve();
    };

    if (!shouldAttemptTls(options.mode)) {
      provisionalSocket = net.createConnection(
        options.port,
        options.dialAddress,
      ) as TelnetSocket;
      provisionalSocket.once('connect', onPlainConnect);
      return;
    }

    provisionalSocket = tls.connect(options.port, options.dialAddress, {
      servername: sniServerName(options.requestedHost),
    }) as unknown as TelnetSocket;
    provisionalSocket.once('secureConnect', onTlsConnect);
  });
};
