import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvParser } from '@adonisjs/core/env';
import { describe, expect, it } from 'vitest';

import { dotenvLine, dotenvValue, shellAssignment, shellQuote } from '../src/env_values.js';

describe('shellQuote', () => {
  it('leaves plain values (ports, hosts, urls) unchanged', () => {
    for (const value of ['5432', '127.0.0.1', 'http://127.0.0.1:9000', 'us-east-1', '']) {
      expect(shellQuote(value)).toBe(value);
    }
  });

  it('single-quotes anything else, escaping single quotes', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('round-trips through a real shell eval', () => {
    const nasty = `a b;$(echo pwned)\`id\`'"\n$HOME`;
    const out = execFileSync(
      'sh',
      ['-c', `eval "$1"; printf %s "$V"`, 'sh', shellAssignment('V', nasty)],
      {
        encoding: 'utf8',
      },
    );
    expect(out).toBe(nasty);
  });
});

describe('shellAssignment', () => {
  it('refuses a key that is not a plain variable name', () => {
    expect(() => shellAssignment('X;id', '1')).toThrow(/not a valid variable name/);
  });
});

describe('dotenvValue / dotenvLine', () => {
  it('leaves plain values unchanged and escapes $', () => {
    expect(dotenvValue('5432')).toBe('5432');
    expect(dotenvValue('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(dotenvValue('pa$$')).toBe('pa\\$\\$');
    expect(dotenvLine('DB_PORT', '5432')).toBe('DB_PORT=5432');
  });

  it('refuses line breaks and NUL', () => {
    expect(dotenvValue('x\nNODE_OPTIONS=--require=evil')).toBeUndefined();
    expect(() => dotenvLine('DB_HOST', 'x\nNODE_OPTIONS=y')).toThrow(/line break/);
    expect(() => dotenvLine('DB_HOST', 'x\ry')).toThrow(/line break/);
    expect(() => dotenvLine('DB_HOST', 'x\0y')).toThrow(/line break/);
  });

  it('refuses a key that is not a plain variable name', () => {
    expect(() => dotenvLine('A=B', '1')).toThrow(/not a valid variable name/);
  });
});

/**
 * The values sail writes are read by two parsers: AdonisJS' env loader (`.env`, `.env.local`,
 * `.env.test.local`) and varlock (`.env.schema`, `.env.local`). Each value below goes through
 * `dotenvLine` and must come back byte-for-byte from BOTH of them.
 */
describe('dotenvLine round-trips through AdonisJS and varlock', () => {
  const values: Record<string, string> = {
    PLAIN: '5432',
    URL: 'http://127.0.0.1:9000',
    DOLLAR: 'p$ss',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${…}` is the point
    BRACED: '${HOME}',
    SUBSHELL: '$(id)',
    TRAILING_DOLLAR: 'x$',
    BACKSLASH_DOLLAR: 'a\\$x',
    BACKSLASH: 'a\\b',
    BACKSLASH_N: 'a\\nb',
    QUOTES_INSIDE: `it's "q"`,
    SPACE: 'a b',
    HASH_INSIDE: 'a#b',
    INLINE_COMMENT: 'a #b',
    LEADING_SPACE: ' lead',
    TRAILING_SPACE: 'trail ',
    DOUBLE_QUOTED: '"q"',
    SINGLE_QUOTED: "'q'",
    BACKTICKS: '`bt`',
    LEADING_HASH: '#x',
    QUOTED_DOLLAR: ' p$ss',
    QUOTED_APOSTROPHE: " it's",
    EQUALS: 'a=b',
  };
  const body = `${Object.entries(values)
    .map(([key, value]) => dotenvLine(key, value))
    .join('\n')}\n`;

  it('AdonisJS reads every value back exactly', async () => {
    expect(
      await new EnvParser(body, new URL(`file://${tmpdir()}/`), { ignoreProcessEnv: true }).parse(),
    ).toEqual(values);
  });

  it('varlock reads every value back exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sail-env-values-'));
    writeFileSync(
      join(dir, '.env.schema'),
      `# @defaultSensitive=false\n# @defaultRequired=false\n# ---\n${body}`,
    );
    const cli = fileURLToPath(new URL('../node_modules/varlock/bin/cli.js', import.meta.url));
    const loaded = JSON.parse(
      execFileSync(process.execPath, [cli, 'load', '--format', 'json'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, VARLOCK_TELEMETRY_DISABLED: 'true' },
      }),
    );
    // varlock coerces untyped items (`5432` → 5432); compare the text it read.
    const read = Object.fromEntries(
      Object.entries(loaded).map(([key, value]) => [key, String(value)]),
    );
    expect(read).toEqual(values);
  }, 30_000);

  it('refuses a value that has no exact spelling instead of writing a different one', () => {
    expect(() => dotenvLine('X', ' "a" $b')).toThrow(/reads back exactly/);
    expect(() => dotenvLine('X', " it's \\n")).toThrow(/reads back exactly/);
  });
});
