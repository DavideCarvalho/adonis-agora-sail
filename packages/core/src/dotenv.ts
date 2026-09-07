import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildSailEnvBlock,
  ensureGitignoreEntry,
  GITIGNORE_FILE_NAME,
  isEncryptedEnvContent,
  LOCAL_ENV_FILE_NAME,
  upsertSailEnvBlock,
} from './varlock.js';

export const DOTENV_FILE_NAME = '.env';
export const DOTENV_EXAMPLE_FILE_NAME = '.env.example';
export const TEST_LOCAL_ENV_FILE_NAME = '.env.test.local';

/**
 * Keys present as `KEY=…` lines. Comments and blank lines are ignored; only
 * the key part is read, values are never interpreted.
 */
export function dotenvKeysPresent(content: string): Set<string> {
  const keys = new Set<string>();
  for (const match of content.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) {
    const key = match[1];
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Upserts `KEY=value` lines, preserving comments, order and blank lines, and
 * appending keys that are not there yet. Returns the input unchanged (same
 * string) when every key already holds the wanted value — callers use that
 * for `unchanged` detection. A single trailing newline is normalized.
 */
export function upsertDotEnvKeys(existing: string | null, values: Record<string, string>): string {
  const wanted = new Map(Object.entries(values));
  if (wanted.size === 0) {
    return existing ?? '';
  }
  if (!existing || existing.trim().length === 0) {
    return `${[...wanted].map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  }

  let changed = false;
  const lines = existing.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  const out = lines.map((line) => {
    const key = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (key && wanted.has(key)) {
      const next = `${key}=${wanted.get(key)}`;
      wanted.delete(key);
      if (next !== line) {
        changed = true;
      }
      return next;
    }
    return line;
  });
  for (const [key, value] of wanted) {
    out.push(`${key}=${value}`);
    changed = true;
  }
  if (!changed) {
    return existing;
  }
  return `${out.join('\n')}\n`;
}

export interface LocalEnvFileSync {
  file: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped-encrypted';
}

export interface SailLocalSyncResult {
  files: LocalEnvFileSync[];
  gitignore: 'updated' | 'unchanged';
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Reads the key sets of the app's `.env` and `.env.example` (empty when the
 * file is missing). `sail:install` uses this to pass *only* missing keys to
 * the codemods — `EnvEditor.add` overwrites existing values, so handing it
 * the full set would clobber hand-tuned ports and passwords.
 */
export async function readDotEnvKeySets(
  appRootPath: string,
): Promise<{ env: Set<string>; example: Set<string> }> {
  const [env, example] = await Promise.all([
    readOptional(join(appRootPath, DOTENV_FILE_NAME)),
    readOptional(join(appRootPath, DOTENV_EXAMPLE_FILE_NAME)),
  ]);
  return {
    env: env ? dotenvKeysPresent(env) : new Set(),
    example: example ? dotenvKeysPresent(example) : new Set(),
  };
}

/**
 * Syncs the stack's resolved app env into the sail-managed block of the local
 * override files every Adonis app loads over `.env`:
 *
 * - `.env.local` — loaded over `.env` in every env except `test`;
 * - `.env.test.local` — the override the loader reads under `NODE_ENV=test`,
 *   where `.env.local` is skipped. Without it, `node ace test` in a worktree
 *   would silently hit the main checkout's database.
 *
 * Both files are created when missing and ensured git-ignored. An encrypted
 * file (varlock ciphertext) is skipped without failing — appending plaintext
 * next to ciphertext would corrupt it.
 */
export async function syncSailLocalEnvs(
  appRootPath: string,
  appEnv: Record<string, string>,
): Promise<SailLocalSyncResult> {
  const block = buildSailEnvBlock(appEnv);
  const files: LocalEnvFileSync[] = [];

  let gitignoreAction: SailLocalSyncResult['gitignore'] = 'unchanged';
  const gitignorePath = join(appRootPath, GITIGNORE_FILE_NAME);
  let gitignoreContent = await readOptional(gitignorePath);
  for (const entry of [LOCAL_ENV_FILE_NAME, TEST_LOCAL_ENV_FILE_NAME]) {
    const next = ensureGitignoreEntry(gitignoreContent, entry);
    if (next.changed) {
      gitignoreContent = next.content;
      gitignoreAction = 'updated';
    }
  }
  if (gitignoreAction === 'updated' && gitignoreContent) {
    await writeFile(gitignorePath, gitignoreContent, 'utf8');
  }

  for (const file of [LOCAL_ENV_FILE_NAME, TEST_LOCAL_ENV_FILE_NAME]) {
    const filePath = join(appRootPath, file);
    const previous = await readOptional(filePath);
    if (previous && isEncryptedEnvContent(previous)) {
      files.push({ file, action: 'skipped-encrypted' });
      continue;
    }
    const next = upsertSailEnvBlock(previous, block);
    if (next === previous) {
      files.push({ file, action: 'unchanged' });
      continue;
    }
    await writeFile(filePath, next, 'utf8');
    files.push({ file, action: previous === null ? 'created' : 'updated' });
  }

  return { files, gitignore: gitignoreAction };
}
