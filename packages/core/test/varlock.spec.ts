import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_EXTRA_PATTERNS_LINES,
  baseAppEnv,
  buildSailEnvBlock,
  buildSchemaSection,
  detectVarlock,
  ensureAuditExtraPatterns,
  ensureGitignoreEntry,
  ensureSchemaSection,
  hasAuditExtraPatterns,
  isEncryptedEnvContent,
  SCHEMA_ROOT_DIVIDER,
  sailEnvKeys,
  syncSailLocalEnv,
  upsertSailEnvBlock,
} from '../src/varlock.js';

describe('detectVarlock', () => {
  it('detects via .env.schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-varlock-schema-'));
    await writeFile(join(dir, '.env.schema'), '# @tag(test)\nAPP_ENV=development\n', 'utf8');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'shop' }), 'utf8');

    const detection = await detectVarlock(pathToFileURL(`${dir}/`));
    expect(detection.inUse).toBe(true);
    expect(detection.via).toBe('schema');
    expect(detection.schemaPath).toBe(join(dir, '.env.schema'));
  });

  it('detects via the varlock dependency (even without a schema file yet)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-varlock-dep-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'shop', devDependencies: { varlock: '^1.0.0' } }),
      'utf8',
    );

    const detection = await detectVarlock(pathToFileURL(`${dir}/`));
    expect(detection).toMatchObject({ inUse: true, via: 'dependency', schemaPath: null });
  });

  it('reports false with neither signal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-varlock-nope-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'shop' }), 'utf8');

    const detection = await detectVarlock(pathToFileURL(`${dir}/`));
    expect(detection).toMatchObject({ inUse: false, via: null, schemaPath: null });
  });
});

describe('sailEnvKeys / baseAppEnv', () => {
  it('unions keys across services without duplicates', () => {
    expect(sailEnvKeys(['postgres', 'redis'])).toEqual([
      'DB_HOST',
      'DB_PORT',
      'DB_USER',
      'DB_PASSWORD',
      'DB_DATABASE',
      'REDIS_HOST',
      'REDIS_PORT',
    ]);
  });

  it('uses main-checkout ports as defaults', () => {
    expect(baseAppEnv(['postgres', 'redis'])).toMatchObject({
      DB_PORT: '5432',
      REDIS_PORT: '6379',
    });
  });
});

describe('buildSchemaSection', () => {
  it('declares typed, tagged items with base defaults', () => {
    const section = buildSchemaSection(['redis']);
    expect(section).toContain('# sail:schema:start');
    expect(section).toContain('# sail:schema:end');
    expect(section).toContain('# @tag(sail)');
    expect(section).toContain('# @type=number');
    expect(section).toContain('REDIS_PORT=6379');
    expect(section).toContain('REDIS_HOST=127.0.0.1');
  });

  it('marks coordinates @public and keeps credentials sensitive', () => {
    const section = buildSchemaSection(['postgres', 'minio']);
    // Hosts, ports, buckets, regions, endpoints are loopback dev addresses —
    // public, so log redaction leaves them readable.
    expect(section).toMatch(/# @public\nDB_HOST=127\.0\.0\.1/);
    expect(section).toMatch(/# @public\n# @type=number\nDB_PORT=5432/);
    expect(section).toMatch(/# @public\nS3_BUCKET=local/);
    // Credentials stay sensitive by default (no @public on their block).
    const passwordBlock = section.split('\n').indexOf('DB_PASSWORD=password');
    expect(passwordBlock).toBeGreaterThan(0);
    expect(section.split('\n')[passwordBlock - 1]).not.toBe('# @public');
    expect(section).not.toMatch(/# @public\nAWS_SECRET_ACCESS_KEY/);
  });
});

describe('ensureSchemaSection', () => {
  it('creates a minimal schema when there is none', () => {
    const { content, added } = ensureSchemaSection(null, ['redis']);
    expect(added).toEqual(['REDIS_HOST', 'REDIS_PORT']);
    expect(content).toContain('REDIS_PORT=6379');
    expect(content).toContain('# sail:schema:start');
  });

  it('appends only missing keys and preserves user declarations', () => {
    const existing = '# @type=string\nDB_HOST=db.internal\n';
    const { content, added } = ensureSchemaSection(existing, ['postgres']);
    expect(added).toEqual(['DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']);
    expect(content).toContain('DB_HOST=db.internal');
    expect(content).toContain('DB_PORT=5432');
    expect(content.match(/^DB_HOST=/gm)).toHaveLength(1);
  });

  it('is a no-op when every key is already declared', () => {
    const { content } = ensureSchemaSection(null, ['redis']);
    expect(ensureSchemaSection(content, ['redis']).added).toEqual([]);
    expect(ensureSchemaSection(content, ['redis']).content).toBe(content);
  });

  it('inserts later services into the existing marker block', () => {
    const { content: once } = ensureSchemaSection(null, ['redis']);
    const { content: twice, added } = ensureSchemaSection(once, ['redis', 'postgres']);
    expect(added).toEqual(['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']);
    expect(twice.match(/# sail:schema:start/g)).toHaveLength(1);
    expect(twice).toContain('DB_PORT=5432');
  });
});

describe('audit extra patterns', () => {
  /**
   * The emitted lines are what varlock parses, so the tests read the patterns
   * back out of them: `regex('...')` bodies, with the `\'` escaping the DSL
   * needs for a single quote inside a single-quoted arg undone.
   */
  function emittedPatterns(): RegExp[] {
    const decorators = AUDIT_EXTRA_PATTERNS_LINES.filter((line) =>
      line.includes('@auditExtraPatterns'),
    );
    const patterns: RegExp[] = [];
    for (const line of decorators) {
      for (const match of line.matchAll(/regex\('((?:[^'\\]|\\.)*)'\)/g)) {
        patterns.push(new RegExp((match[1] as string).replace(/\\'/g, "'")));
      }
    }
    return patterns;
  }

  it('emits exactly two decorator calls, one per idiom, each with a comment', () => {
    expect(AUDIT_EXTRA_PATTERNS_LINES).toHaveLength(4);
    expect(AUDIT_EXTRA_PATTERNS_LINES[0]?.startsWith('# @')).toBe(false);
    expect(AUDIT_EXTRA_PATTERNS_LINES[1]).toContain('# @auditExtraPatterns(');
    expect(AUDIT_EXTRA_PATTERNS_LINES[2]?.startsWith('# @')).toBe(false);
    expect(AUDIT_EXTRA_PATTERNS_LINES[3]).toContain('# @auditExtraPatterns(');
    // Every pattern is a regex() call — a bare /.../ arg cannot hold parens.
    for (const line of AUDIT_EXTRA_PATTERNS_LINES.filter((l) => l.includes('@audit'))) {
      expect(line).toContain("regex('");
    }
    // No anchors: the scan runs without the `m` flag.
    expect(AUDIT_EXTRA_PATTERNS_LINES.join('\n')).not.toMatch(/[^\\][$^]/);
  });

  it('captures the env key from real Adonis snippets', () => {
    const [singleQuoted, doubleQuoted, declaration] = emittedPatterns();
    expect(emittedPatterns()).toHaveLength(3);

    expect("const host = env.get('DB_HOST')".match(singleQuoted as RegExp)?.[1]).toBe('DB_HOST');
    expect('const host = env.get("DB_HOST")'.match(doubleQuoted as RegExp)?.[1]).toBe('DB_HOST');
    expect('  DB_HOST: Env.schema.string(),'.match(declaration as RegExp)?.[1]).toBe('DB_HOST');

    // Second-argument defaults and whitespace variants are common in config/*.ts.
    expect("  host: env.get( 'DB_HOST', '127.0.0.1'),".match(singleQuoted as RegExp)?.[1]).toBe(
      'DB_HOST',
    );
    expect('  PORT: Env.schema.number(),'.match(declaration as RegExp)?.[1]).toBe('PORT');
    expect(
      "    LOG_LEVEL: Env.schema.enum(['fatal', 'info'] as const),".match(
        declaration as RegExp,
      )?.[1],
    ).toBe('LOG_LEVEL');
  });

  it('does not fire on unrelated code', () => {
    const [singleQuoted, , declaration] = emittedPatterns();
    expect("cache.get('DB_HOST')").not.toMatch(singleQuoted as RegExp);
    expect('  name: vine.string(),').not.toMatch(declaration as RegExp);
  });

  it('inserts the lines immediately above an existing divider', () => {
    const existing = ['# @defaultSensitive(false)', SCHEMA_ROOT_DIVIDER, 'APP_ENV=development', ''];
    const { content, action } = ensureAuditExtraPatterns(existing.join('\n'));
    expect(action).toBe('inserted');
    expect(content.split('\n')).toEqual([
      '# @defaultSensitive(false)',
      ...AUDIT_EXTRA_PATTERNS_LINES,
      SCHEMA_ROOT_DIVIDER,
      'APP_ENV=development',
      '',
    ]);
  });

  it('leaves a schema that already declares the decorator alone', () => {
    const existing = [
      '# @auditExtraPatterns(regex(\'cfg\\.get\\("([A-Z_]+)"\\)\'))',
      SCHEMA_ROOT_DIVIDER,
      'APP_ENV=development',
      '',
    ].join('\n');
    const { content, action } = ensureAuditExtraPatterns(existing);
    expect(action).toBe('present');
    expect(content).toBe(existing);
    expect(content.match(/@auditExtraPatterns/g)).toHaveLength(1);
  });

  it('reports instead of writing when the schema has no divider', () => {
    const existing = '# our env\nAPP_ENV=development\n';
    const { content, action } = ensureAuditExtraPatterns(existing);
    expect(action).toBe('manual');
    expect(content).toBe(existing);
  });

  it('recognizes long dividers and rejects non-divider lines', () => {
    expect(ensureAuditExtraPatterns('# ------\nA=1\n').action).toBe('inserted');
    expect(ensureAuditExtraPatterns('# -\nA=1\n').action).toBe('manual');
    expect(hasAuditExtraPatterns('# @auditIgnorePaths(fixtures)\n')).toBe(false);
  });
});

describe('ensureSchemaSection + audit patterns', () => {
  it('creates a root section with the decorators above the divider', () => {
    const { content, auditPatterns } = ensureSchemaSection(null, ['redis']);
    expect(auditPatterns).toBe('created');

    const lines = content.split('\n');
    const divider = lines.indexOf(SCHEMA_ROOT_DIVIDER);
    const decorator = lines.findIndex((line) => line.includes('@auditExtraPatterns'));
    const block = lines.indexOf('# sail:schema:start');
    expect(decorator).toBeGreaterThan(0);
    expect(divider).toBeGreaterThan(decorator);
    expect(block).toBeGreaterThan(divider);
    // Header comments stay first, item block below the divider is unchanged.
    expect(lines[0]).toContain('Managed by @adonis-agora/sail');
    expect(content.slice(content.indexOf('# sail:schema:start'))).toBe(
      `${buildSchemaSection(['redis'])}\n`,
    );
    expect(lines.filter((line) => line === SCHEMA_ROOT_DIVIDER)).toHaveLength(1);
  });

  it('inserts the decorators above the divider of an existing schema', () => {
    const existing = `# @defaultRequired(false)\n${SCHEMA_ROOT_DIVIDER}\nDB_HOST=db.internal\n`;
    const { content, added, auditPatterns } = ensureSchemaSection(existing, ['postgres']);
    expect(auditPatterns).toBe('inserted');
    expect(added).toEqual(['DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']);
    expect(content.indexOf('@auditExtraPatterns')).toBeLessThan(
      content.indexOf(SCHEMA_ROOT_DIVIDER),
    );
    expect(content).toContain('DB_HOST=db.internal');
    expect(content).toContain('DB_PORT=5432');
  });

  it('never emits a second copy of the decorator', () => {
    const { content: once } = ensureSchemaSection(null, ['redis']);
    const twice = ensureSchemaSection(once, ['redis', 'postgres']);
    expect(twice.auditPatterns).toBe('present');
    expect(twice.content.match(/@auditExtraPatterns/g)).toHaveLength(2);

    const handWritten = `# @auditExtraPatterns(regex('cfg\\.get'))\n${SCHEMA_ROOT_DIVIDER}\nA=1\n`;
    const merged = ensureSchemaSection(handWritten, ['redis']);
    expect(merged.auditPatterns).toBe('present');
    expect(merged.content.match(/@auditExtraPatterns/g)).toHaveLength(1);
  });

  it('reports, without rewriting, a schema that has no divider', () => {
    const existing = '# @type=string\nDB_HOST=db.internal\n';
    const { content, added, auditPatterns } = ensureSchemaSection(existing, ['postgres']);
    expect(auditPatterns).toBe('manual');
    expect(content).not.toContain('@auditExtraPatterns');
    expect(content).not.toContain(SCHEMA_ROOT_DIVIDER);
    // The keys are still appended — only the divider-dependent part is skipped.
    expect(added).toEqual(['DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']);
    expect(content.startsWith(existing)).toBe(true);
  });
});

describe('buildSailEnvBlock / upsertSailEnvBlock', () => {
  const block = buildSailEnvBlock({ DB_PORT: '5555', DB_HOST: '127.0.0.1' });

  it('renders sorted KEY=value lines between markers', () => {
    expect(block).toBe(
      [
        '# sail:start',
        '# Managed by @adonis-agora/sail — per-worktree service ports. Do not edit;',
        '# re-run `node ace sail:sync-env` to refresh.',
        'DB_HOST=127.0.0.1',
        'DB_PORT=5555',
        '# sail:end',
      ].join('\n'),
    );
  });

  it('creates the file body when there is none', () => {
    expect(upsertSailEnvBlock(null, block)).toBe(`${block}\n`);
  });

  it('replaces the block in place and preserves everything else', () => {
    const existing = `# user stuff\nAPP_ENV=development\n\n${block}\n`;
    const refreshed = buildSailEnvBlock({ DB_PORT: '5556', DB_HOST: '127.0.0.1' });
    const next = upsertSailEnvBlock(existing, refreshed);
    expect(next).toContain('APP_ENV=development');
    expect(next).toContain('DB_PORT=5556');
    expect(next).not.toContain('DB_PORT=5555');
    expect(next.match(/# sail:start/g)).toHaveLength(1);
  });
});

describe('isEncryptedEnvContent', () => {
  it('flags ciphertext entries and passes plaintext through', () => {
    expect(isEncryptedEnvContent('SECRET=varlock(local:ABC123...)\n')).toBe(true);
    expect(isEncryptedEnvContent('DB_PORT=5555\n')).toBe(false);
  });
});

describe('ensureGitignoreEntry', () => {
  it('creates the body when missing and appends otherwise', () => {
    expect(ensureGitignoreEntry(null)).toEqual({ content: '.env.local\n', changed: true });
    expect(ensureGitignoreEntry('node_modules\n')).toEqual({
      content: 'node_modules\n.env.local\n',
      changed: true,
    });
  });

  it('leaves existing entries alone', () => {
    expect(ensureGitignoreEntry('.env.local\n').changed).toBe(false);
    expect(ensureGitignoreEntry('/.env.local\n').changed).toBe(false);
    // similarly-named entries do not count
    expect(ensureGitignoreEntry('.env.local.example\n').changed).toBe(true);
  });
});

describe('syncSailLocalEnv', () => {
  it('creates .env.local and .gitignore on a fresh checkout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-sync-fresh-'));

    const result = await syncSailLocalEnv(dir, { DB_PORT: '5432' });
    expect(result.action).toBe('created');
    expect(result.gitignore).toBe('updated');
    expect(await readFile(join(dir, '.env.local'), 'utf8')).toContain('DB_PORT=5432');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.env.local');
  });

  it('is a no-op when ports did not change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-sync-idem-'));
    await syncSailLocalEnv(dir, { DB_PORT: '5432' });

    const result = await syncSailLocalEnv(dir, { DB_PORT: '5432' });
    expect(result.action).toBe('unchanged');
  });

  it('skips encrypted files instead of corrupting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sail-sync-enc-'));
    await writeFile(join(dir, '.env.local'), 'SECRET=varlock(local:ABC123...)\n', 'utf8');

    const result = await syncSailLocalEnv(dir, { DB_PORT: '5432' });
    expect(result.action).toBe('skipped-encrypted');
    expect(await readFile(join(dir, '.env.local'), 'utf8')).not.toContain('DB_PORT');
  });
});
