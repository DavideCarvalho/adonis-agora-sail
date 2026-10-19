import { describe, expect, it } from 'vitest';

import { resolveServiceImages } from '../src/images.js';
import { parseSailConfig, updateSailConfigContent } from '../src/sail_config.js';

describe('parseSailConfig', () => {
  it('reads every preference', () => {
    expect(
      parseSailConfig({
        objectStorage: 'garage',
        exclude: ['mailpit', 'object-storage'],
        images: { postgres: 'postgres:16' },
      }),
    ).toEqual({
      config: {
        objectStorage: 'garage',
        exclude: ['mailpit', 'object-storage'],
        images: { postgres: 'postgres:16' },
      },
      problems: [],
    });
  });

  it('drops and reports what it does not know, never failing', () => {
    const { config, problems } = parseSailConfig({
      objectStorage: 'ceph',
      exclude: ['mongo', 'redis'],
      images: { meili: 'x' },
    });
    expect(config).toEqual({ exclude: ['redis'], images: {} });
    expect(problems).toHaveLength(3);
  });

  it('treats a missing key as the empty config', () => {
    expect(parseSailConfig(undefined)).toEqual({
      config: { exclude: [], images: {} },
      problems: [],
    });
  });
});

describe('updateSailConfigContent', () => {
  const pkg = `{\n  "name": "shop",\n  "sail": { "exclude": ["redis"] }\n}\n`;

  it('merges exclusions and sets the backend, keeping indentation and the final newline', () => {
    const next = updateSailConfigContent(pkg, {
      objectStorage: 'rustfs',
      exclude: ['redis', 'mailpit'],
    });
    expect(JSON.parse(next).sail).toEqual({
      exclude: ['redis', 'mailpit'],
      objectStorage: 'rustfs',
    });
    expect(next).toContain('\n  "name": "shop"');
    expect(next.endsWith('}\n')).toBe(true);
  });

  it('returns the same string when there is nothing new', () => {
    expect(updateSailConfigContent(pkg, { exclude: ['redis'] })).toBe(pkg);
  });
});

describe('resolveServiceImages', () => {
  it('leaves the catalog alone without pgvector or overrides', () => {
    expect(resolveServiceImages({ images: {} }, false)).toEqual({});
  });

  it('switches to the pgvector build of the same major', () => {
    expect(resolveServiceImages({ images: {} }, true)).toEqual({
      postgres: 'pgvector/pgvector:pg17',
    });
    expect(resolveServiceImages({ images: { postgres: 'postgres:16-alpine' } }, true)).toEqual({
      postgres: 'pgvector/pgvector:pg16',
    });
  });

  it('never second-guesses a custom image', () => {
    expect(resolveServiceImages({ images: { postgres: 'ghcr.io/me/pg:1' } }, true)).toEqual({
      postgres: 'ghcr.io/me/pg:1',
    });
  });
});
