/**
 * Central log redaction (MWP-94, items 3–6).
 *
 * Redaction applied at call sites decays: the guarantee holds only for the log
 * statements someone remembered, and every statement added later is a fresh
 * chance to leak. So this is applied once inside `srv.log()` and tested here as
 * a unit.
 *
 * Three separate hazards, deliberately not conflated:
 *
 *  - **Secrets by value.** The shared secret and admin token are known strings;
 *    anything containing them must not reach a log, wherever it came from.
 *  - **Identifiers.** Session and device tokens are credentials, but operators
 *    genuinely need to correlate lines. A stable truncated hash gives
 *    correlation without holding the credential.
 *  - **Control sequences.** Log content is attacker-chosen. An operator running
 *    `cat` on a log file hands their terminal to whoever wrote the bytes:
 *    ANSI can rewrite earlier lines, and some sequences can be made to inject
 *    input. Stripping them is about protecting the reader, not the data.
 */

import { asDouble } from './support/doubles';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  neutralizeControlSequences,
  redactLogMessage,
  shortHash,
  tokenSummary,
} from '../src/log-redaction.js';

describe('secrets are removed by value', () => {
  const secrets = ['s3cret-shared-value-at-least-32-chars', 'admin-tok-99'];

  test('a secret appearing anywhere is replaced', () => {
    const out = redactLogMessage(
      'auth failed for s3cret-shared-value-at-least-32-chars on /ws',
      { secrets },
    );
    expect(out).not.toContain('s3cret-shared-value-at-least-32-chars');
    expect(out).toContain('[redacted]');
  });

  test('every occurrence is replaced, not just the first', () => {
    const out = redactLogMessage('admin-tok-99 then admin-tok-99', {
      secrets,
    });
    expect(out).not.toContain('admin-tok-99');
  });

  test('an empty or absent secret does not blank the message', () => {
    // A common configuration is no shared secret at all. Treating '' as a
    // value to replace would redact between every character.
    const out = redactLogMessage('nothing sensitive here', {
      secrets: ['', asDouble<string>()(undefined)],
    });
    expect(out).toBe('nothing sensitive here');
  });

  test('a secret containing regex metacharacters is still removed', () => {
    // Secrets are operator-chosen and may contain anything. Building a regex
    // from one unescaped would either throw or match the wrong thing.
    const out = redactLogMessage('token=a.b*c+d?e', {
      secrets: ['a.b*c+d?e'],
    });
    expect(out).not.toContain('a.b*c+d?e');
  });
});

describe('control sequences are neutralized', () => {
  test('ANSI colour sequences are stripped', () => {
    expect(neutralizeControlSequences('\x1b[31mred\x1b[0m')).toBe('red');
  });

  test('cursor movement that could rewrite earlier output is stripped', () => {
    // The reason this matters: an attacker who can move the cursor up can
    // overwrite lines an operator already read.
    expect(neutralizeControlSequences('a\x1b[2Ab')).toBe('ab');
  });

  test('OSC sequences, which can set the window title, are stripped', () => {
    expect(neutralizeControlSequences('x\x1b]0;pwned\x07y')).toBe('xy');
  });

  test('newlines and carriage returns cannot forge a new log line', () => {
    // Otherwise attacker content can fabricate what looks like a separate,
    // authentic log entry.
    const out = neutralizeControlSequences('real\nINFO forged entry\r\n');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
  });

  test('bare escape and bell are stripped', () => {
    expect(neutralizeControlSequences('a\x1bb\x07c')).toBe('abc');
  });

  test('ordinary text and punctuation survive intact', () => {
    const text = 'connect mud.example.org:4000 — "quoted" [bracketed] 100%';
    expect(neutralizeControlSequences(text)).toBe(text);
  });

  test('tabs become spaces rather than vanishing', () => {
    // Losing the separator entirely would silently join two fields.
    expect(neutralizeControlSequences('a\tb')).toBe('a b');
  });
});

describe('identifiers become stable truncated hashes', () => {
  test('the same value always hashes the same, so lines correlate', () => {
    expect(shortHash('session-abc')).toBe(shortHash('session-abc'));
  });

  test('different values differ', () => {
    expect(shortHash('session-abc')).not.toBe(shortHash('session-abd'));
  });

  test('the original value is not recoverable from the output', () => {
    const value = 'device-token-9f8e7d';
    expect(shortHash(value)).not.toContain(value);
  });

  test('the output is short enough to read in a log line', () => {
    expect(shortHash('anything').length).toBeLessThanOrEqual(20);
  });
});

describe('redactLogMessage composes both concerns', () => {
  test('strips control sequences and secrets together', () => {
    const out = redactLogMessage('\x1b[31mkey=hunter2\x1b[0m', {
      secrets: ['hunter2'],
    });
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('\x1b');
  });

  test('a secret hidden behind an escape sequence is still caught', () => {
    // Control characters are removed first, so a secret cannot be smuggled
    // past the value match by splitting it with an escape.
    const out = redactLogMessage('hun\x1b[0mter2', { secrets: ['hunter2'] });
    expect(out).not.toContain('hunter2');
  });

  test('non-string input is coerced rather than throwing', () => {
    // srv.log accepts unknown; a thrown error inside logging would take down
    // the path it was meant to observe.
    expect(redactLogMessage(undefined, { secrets: [] })).toBe('undefined');
    expect(redactLogMessage(42, { secrets: [] })).toBe('42');
    expect(redactLogMessage({ a: 1 }, { secrets: [] })).toContain('a');
  });

  test('an Error is rendered with its message', () => {
    expect(redactLogMessage(new Error('boom'), { secrets: [] })).toContain(
      'boom',
    );
  });
});

describe('the connect frame cannot raise server verbosity (MWP-94 item 1)', () => {
  // The defect: `debug: true` in a client's connect frame set socket.debug,
  // which switched on logging of that client's own messages and its raw
  // forwarded input. Anyone able to connect could turn on disclosure and a
  // disk-fill vector at once.

  test('no code path assigns socket.debug from a client message', () => {
    const integration = readFileSync('src/session-integration.ts', 'utf8');
    expect(integration).not.toMatch(/socket\.debug\s*=/);
    expect(integration).not.toMatch(/debug:\s*msg\.debug/);
  });

  test('forward() logs a byte count, never the bytes', () => {
    // password_mode is best-effort ECHO detection, so gating content logging on
    // it leaked any password typed at a prompt the proxy did not recognise.
    const proxy = readFileSync('wsproxy.ts', 'utf8');
    expect(proxy).not.toMatch(/logDebug\('forward: ' \+ d/);
    expect(proxy).toMatch(/forward: \$\{d\.length\} bytes/);
  });
});

describe('device tokens are hashed, not truncated', () => {
  test('no log path emits a prefix of a real token', () => {
    // Logging the first 8 characters is credential material in a log file:
    // enough to correlate, and also a genuine fragment of a real secret.
    const nm = readFileSync('src/notification-manager.ts', 'utf8');
    // The property, not the implementation: an earlier version of this asserted
    // a literal `shortHash(trimmed)` call and broke when the helper was shared,
    // even though nothing about the behaviour had changed.
    expect(nm).not.toMatch(/slice\(0,\s*8\)/);
    expect(nm).toMatch(/tokenSummary/);
  });
});

describe('a client cannot inject or forge log lines', () => {
  // SessionIntegration has its own logger writing straight to console.log, so
  // it never inherited srv.log's redaction — and it logs the client-supplied
  // target host. Demonstrated before the fix: a host carrying ANSI and a
  // newline produced a log entry indistinguishable from a genuine startup line.
  // That is worse than a leak, because it makes the log actively misleading.

  test('the session logger neutralizes what it writes', () => {
    const integration = readFileSync('src/session-integration.ts', 'utf8');
    expect(integration).toMatch(/console\.log\(neutralizeControlSequences\(/);
  });

  test('a forged line and escapes are stripped, host still readable', () => {
    const hostile = 'evil\x1b[31m\nINFO [init] server listening: 0.0.0.0:6200';
    const out = neutralizeControlSequences(
      `2026-01-01T00:00:00Z [session] connect request to ${hostile}:4000`,
    );

    expect(out).not.toContain('\x1b');
    expect(out).not.toMatch(/\n/);
    // Diagnostics must survive redaction, or operators lose the reason they
    // read logs at all.
    expect(out).toContain('evil');
    expect(out).toContain('connect request to');
  });
});

describe('credential summaries hash rather than truncate', () => {
  // Raised by Codex review of #76. The first fix covered
  // NotificationManager's private helper and missed six other sites, each of
  // which had rolled its own `slice(0, 8)`. The duplication is why the miss
  // happened, so this is one exported helper used everywhere.

  test('the summary contains no prefix of the value', () => {
    // Built rather than written as a literal. A 32-character hex string in the
    // source is indistinguishable from a real credential to a secret scanner —
    // gitleaks flagged the literal version of this line as a generic-api-key —
    // and allowlisting it would have taught the scanner to ignore exactly the
    // shape it exists to catch.
    const token = Array.from({ length: 8 }, (_, i) => `dead${i}beef`).join('');
    const summary = tokenSummary(token);
    expect(summary).not.toContain(token.slice(0, 8));
    expect(summary).not.toContain(token);
  });

  test('it keeps the length, which is diagnostic and not sensitive', () => {
    expect(tokenSummary('0123456789')).toContain('len=10');
  });

  test('it is stable, so lines still correlate', () => {
    expect(tokenSummary('same-token')).toBe(tokenSummary('same-token'));
  });

  test('empty and whitespace values are reported, not hashed', () => {
    expect(tokenSummary('')).toBe('<empty>');
    expect(tokenSummary('   ')).toBe('<empty>');
  });

  test('no call site truncates a device token or App Attest key id', () => {
    // The mechanical check the review would have caught earlier: a prefix of a
    // credential is credential material, wherever it is built.
    const proxy = readFileSync('wsproxy.ts', 'utf8');
    expect(proxy).not.toMatch(/targetDeviceToken\.slice\(0,\s*8\)/);
    expect(proxy).not.toMatch(/keyId(?:Str)?\.slice\(0,\s*8\)/);
    expect(proxy).not.toMatch(/body\.keyId\.slice\(0,\s*8\)/);

    const nm = readFileSync('src/notification-manager.ts', 'utf8');
    expect(nm).not.toMatch(/trimmed\.slice\(0,\s*8\)/);
  });
});
