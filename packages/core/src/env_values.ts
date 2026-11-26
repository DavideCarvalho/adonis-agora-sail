/**
 * Writing env values out safely — to a shell (`eval "$(node ace sail:info --env)"`) and to dotenv
 * files (`.env.local`, `.env.schema`, …). Today every value sail writes is a constant or a port,
 * so these are no-ops for them; they keep a future value (a path with a space, a password with a
 * `$`) from turning into shell code or into a second dotenv line.
 */

/** A variable name a shell and a dotenv parser both read as one plain name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertEnvName(key: string): void {
  if (!ENV_NAME.test(key)) {
    throw new Error(
      `Refusing to write env variable ${JSON.stringify(key)}: not a valid variable name`,
    );
  }
}

/**
 * `value` as one shell word: unchanged when it is only safe characters (ports, hosts, urls), else
 * single-quoted with every `'` written as `'\''`.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `value` for a dotenv line, written so that both readers of sail's files — AdonisJS' env parser
 * (`.env*`) and varlock (`.env.schema`, `.env.local`) — read back exactly `value`; `undefined` when
 * no such spelling exists. Both readers were checked to agree on every form used here:
 *
 * - plain: `$` written `\$` (both unescape it; neither interpolates it). Ports, hosts and urls
 *   come out unchanged;
 * - a value an unquoted line would mangle (leading/trailing space, a leading quote, any `#` —
 *   varlock starts a comment at `a#b`'s `#`, AdonisJS only at ` #`) is single-quoted, or double-quoted with `\$` when it holds a `$` or `'`
 *   (AdonisJS interpolates `$` even inside single quotes, and neither reader unescapes `\'`);
 * - refused: a line break or NUL (it would end the line and let the value declare other variables,
 *   e.g. `NODE_OPTIONS`), and a value needing quotes that also holds `"` or `\` alongside `$`/`'`
 *   (double quotes turn `\n` into a newline and neither reader unescapes `\"` the same way).
 */
export function dotenvValue(value: string): string | undefined {
  if (/[\r\n\0]/.test(value)) return undefined;
  const needsQuotes = /^\s|\s$|^["'`]|#/.test(value);
  if (!needsQuotes) return value.replaceAll('$', '\\$');
  if (!/[$']/.test(value)) return `'${value}'`;
  if (!/["\\]/.test(value)) return `"${value.replaceAll('$', '\\$')}"`;
  return undefined;
}

/** A `KEY=value` line for a shell `eval`. Throws on a key that is not a plain variable name. */
export function shellAssignment(key: string, value: string): string {
  assertEnvName(key);
  return `${key}=${shellQuote(value)}`;
}

/**
 * A `KEY=value` dotenv line. Throws on a key that is not a plain variable name or a value that has
 * no exact dotenv spelling (a line break, see {@link dotenvValue}) — sail never writes a line that
 * would be read back as something else.
 */
export function dotenvLine(key: string, value: string): string {
  assertEnvName(key);
  const safe = dotenvValue(value);
  if (safe === undefined) {
    throw new Error(
      /[\r\n\0]/.test(value)
        ? `Refusing to write ${key} to a dotenv file: its value contains a line break`
        : `Refusing to write ${key} to a dotenv file: its value cannot be written so it reads back exactly`,
    );
  }
  return `${key}=${safe}`;
}
