/**
 * Certificate subjects are safe to put in a log line (MWP-137).
 *
 * Found in the live production journal while gathering MWP-126 evidence: two
 * `[app-attest]` warnings carry no timestamp and no level, because they go
 * through `console.warn` rather than `srv.log()`. That bypasses
 * `redactLogMessage()`, which is the one place control sequences are
 * neutralized — the whole point of MWP-94 having centralised it.
 *
 * One of the two interpolates a **client-supplied** certificate subject, and
 * it is reached precisely when the certificate is not the expected Apple one:
 * the adversarial case. It fires routinely in production today.
 *
 * The old code replaced `\r?\n` and nothing else. That blocks a forged log
 * line, which is the loudest attack, and leaves every other control sequence
 * intact — including the cursor movement that lets attacker input overwrite
 * output an operator has already read.
 */

import { describe, expect, test } from 'bun:test';
import { formatCertSubjectForLog } from '../src/app-attest.js';

describe('the RDN separator behaviour is preserved', () => {
  // These are why the function does not simply call neutralizeControlSequences:
  // that deletes newlines rather than replacing them, which would run the
  // components together into "CN=…OU=…O=Apple Inc.".

  test('newline-separated components become a single readable line', () => {
    const subject =
      'CN=abc\nOU=AAA Certification\nO=Apple Inc.\nST=California';
    expect(formatCertSubjectForLog(subject)).toBe(
      'CN=abc, OU=AAA Certification, O=Apple Inc., ST=California',
    );
  });

  test('CRLF separators work the same way', () => {
    expect(formatCertSubjectForLog('CN=abc\r\nO=Apple Inc.')).toBe(
      'CN=abc, O=Apple Inc.',
    );
  });

  test('an ordinary subject is unchanged', () => {
    const subject = 'CN=SM622QTWFY.com.example.app, O=Example Inc.';
    expect(formatCertSubjectForLog(subject)).toBe(subject);
  });
});

describe('a hostile subject cannot manipulate the operator terminal', () => {
  test('ANSI colour sequences are stripped', () => {
    const out = formatCertSubjectForLog('CN=\x1b[31mred\x1b[0m');
    expect(out).not.toContain('\x1b');
    expect(out).toContain('red');
  });

  test('cursor movement that could overwrite earlier output is stripped', () => {
    // The attack this exists for: move the cursor up and rewrite a line the
    // operator has already read.
    const out = formatCertSubjectForLog('CN=a\x1b[2Ab');
    expect(out).not.toContain('\x1b');
    expect(out).toBe('CN=ab');
  });

  test('OSC sequences, which can set the window title, are stripped', () => {
    const out = formatCertSubjectForLog('CN=x\x1b]0;pwned\x07y');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
  });

  test('bare escape and bell are stripped', () => {
    expect(formatCertSubjectForLog('CN=a\x1bb\x07c')).toBe('CN=abc');
  });

  test('no control character survives, whatever it is', () => {
    // Broader than the named cases: a subject is attacker-chosen, so assert
    // the class rather than the examples someone thought of.
    const hostile = Array.from({ length: 32 }, (_, i) =>
      String.fromCharCode(i),
    ).join('');
    const out = formatCertSubjectForLog(`CN=${hostile}`);
    // Tab is deliberately kept as a space — deleting it would join two fields.
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/);
  });

  test('a forged log line cannot be fabricated', () => {
    // The original replace already covered this. Kept so that a future
    // rewrite cannot lose it while satisfying the ANSI cases above.
    const out = formatCertSubjectForLog(
      'CN=evil\nINFO  [init] server listening: 0.0.0.0:6200',
    );
    expect(out).not.toContain('\n');
    expect(out).toContain('evil');
  });

  test('the subject is still legible after neutralization', () => {
    // Redaction that destroys the diagnostic defeats the reason the line is
    // logged at all.
    const out = formatCertSubjectForLog(
      'CN=\x1b[31m40f0aa48\x1b[0m\nO=Apple Inc.',
    );
    expect(out).toContain('40f0aa48');
    expect(out).toContain('O=Apple Inc.');
  });
});
