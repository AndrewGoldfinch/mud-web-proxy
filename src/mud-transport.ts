// SPDX-License-Identifier: GPL-3.0-or-later

import net from 'net';
import tls from 'tls';
import type { MudTlsMode } from './runtime-config';
import type { TelnetSocket } from './types';
import { parseIPv4 } from './wsproxy-utils';

const TLS_HANDSHAKE_TIMEOUT_MS = 4_000;

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
  return new Promise((resolve, reject) => {
    let provisionalSocket: TelnetSocket | null = null;
    let tlsSocket: TelnetSocket | null = null;
    let plainSocket: TelnetSocket | null = null;
    let settled = false;
    let plaintextAttempted = false;
    let downgraded = false;
    let tlsHandshakeTimer: ReturnType<typeof setTimeout> | undefined;

    const onPlainConnect = (): void => {
      if (!plainSocket || provisionalSocket !== plainSocket) return;
      handoff({
        socket: plainSocket,
        transport: 'plain',
        downgraded,
      });
    };
    const onPlainError = (err: Error): void => {
      fail(err);
    };
    const onPlainClose = (): void => {
      fail(new Error('Plain MUD connection closed before handoff'));
    };
    const onTlsTcpConnect = (): void => {
      if (settled || tlsHandshakeTimer) return;
      tlsHandshakeTimer = setTimeout(
        onTlsHandshakeDeadline,
        TLS_HANDSHAKE_TIMEOUT_MS,
      );
    };
    const onTlsHandshakeDeadline = (): void => {
      if (settled) return;
      if (options.mode === 'prefer') {
        fallBackToPlain(
          `TLS handshake timed out after ${TLS_HANDSHAKE_TIMEOUT_MS}ms`,
        );
        return;
      }

      fail(
        new Error(
          'MUD_TLS_MODE=required: TLS handshake timed out after 4000ms and plaintext fallback is not permitted.',
        ),
      );
    };
    const onTlsSecureConnect = (): void => {
      if (!tlsSocket || provisionalSocket !== tlsSocket) return;
      handoff({
        socket: tlsSocket,
        transport: 'tls',
        downgraded: false,
      });
    };
    const onTlsError = (err: Error): void => {
      if (shouldFallBackToPlain(options.mode, 'error', err)) {
        fallBackToPlain(`TLS failed (${err.message})`);
        return;
      }

      if (options.mode === 'required') {
        fail(
          new Error(
            'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
            { cause: err },
          ),
        );
        return;
      }

      fail(err);
    };
    const onTlsClose = (): void => {
      if (shouldFallBackToPlain(options.mode, 'close')) {
        fallBackToPlain('peer closed during TLS handshake');
        return;
      }

      fail(
        new Error(
          'MUD_TLS_MODE=required: TLS connection failed and plaintext fallback is not permitted.',
        ),
      );
    };
    const removePlainListeners = (): void => {
      if (!plainSocket) return;
      plainSocket.off('connect', onPlainConnect);
      plainSocket.off('error', onPlainError);
      plainSocket.off('close', onPlainClose);
    };
    const removeTlsListeners = (): void => {
      if (!tlsSocket) return;
      tlsSocket.off('connect', onTlsTcpConnect);
      tlsSocket.off('secureConnect', onTlsSecureConnect);
      tlsSocket.off('error', onTlsError);
      tlsSocket.off('close', onTlsClose);
    };
    const removeConnectorListeners = (): void => {
      removePlainListeners();
      removeTlsListeners();
    };
    const removeAbortListener = (): void => {
      options.signal.removeEventListener('abort', onAbort);
    };
    const clearTlsHandshakeTimer = (): void => {
      if (!tlsHandshakeTimer) return;
      clearTimeout(tlsHandshakeTimer);
      tlsHandshakeTimer = undefined;
    };
    const handoff = (connection: ConnectedMudTransport): void => {
      if (settled) return;
      settled = true;
      clearTlsHandshakeTimer();
      removeConnectorListeners();
      removeAbortListener();
      try {
        options.onConnected(connection);
      } catch (err) {
        connection.socket.destroy();
        reject(err);
        return;
      }
      resolve();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTlsHandshakeTimer();
      removeConnectorListeners();
      removeAbortListener();
      provisionalSocket?.destroy();
      reject(err);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTlsHandshakeTimer();
      removeConnectorListeners();
      removeAbortListener();
      provisionalSocket?.destroy();
      reject(new Error('MUD transport connection aborted'));
    };
    const startPlain = (): void => {
      try {
        plainSocket = net.createConnection(
          options.port,
          options.dialAddress,
        ) as TelnetSocket;
        provisionalSocket = plainSocket;
        plainSocket.once('connect', onPlainConnect);
        plainSocket.once('error', onPlainError);
        plainSocket.once('close', onPlainClose);
      } catch (err) {
        fail(err as Error);
      }
    };
    const fallBackToPlain = (reason: string): void => {
      if (settled || plaintextAttempted) return;
      plaintextAttempted = true;
      clearTlsHandshakeTimer();
      removeTlsListeners();
      tlsSocket?.destroy();
      downgraded = true;
      try {
        options.onDowngrade(reason);
      } catch (err) {
        fail(err as Error);
        return;
      }
      if (settled) return;
      startPlain();
    };

    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener('abort', onAbort, { once: true });

    if (!shouldAttemptTls(options.mode)) {
      plaintextAttempted = true;
      startPlain();
      return;
    }

    try {
      tlsSocket = tls.connect(options.port, options.dialAddress, {
        servername: sniServerName(options.requestedHost),
      }) as unknown as TelnetSocket;
      provisionalSocket = tlsSocket;
      tlsSocket.once('connect', onTlsTcpConnect);
      tlsSocket.once('secureConnect', onTlsSecureConnect);
      tlsSocket.once('error', onTlsError);
      tlsSocket.once('close', onTlsClose);
    } catch (err) {
      onTlsError(err as Error);
    }
  });
};
