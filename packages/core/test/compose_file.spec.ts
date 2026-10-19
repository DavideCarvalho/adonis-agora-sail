import { describe, expect, it } from 'vitest';

import {
  generateComposeFile,
  mergeComposeFile,
  serviceImageInComposeFile,
  servicesInComposeFile,
} from '../src/compose_file.js';

describe('generateComposeFile', () => {
  it('emits the managed-file header', () => {
    expect(generateComposeFile(['postgres']).split('\n')[0]).toMatch(
      /Managed by @adonis-agora\/sail/,
    );
  });

  it('interpolates host ports so the file works with and without sail', () => {
    const content = generateComposeFile(['postgres', 'mailpit']);
    expect(content).toContain('${SAIL_POSTGRES_PORT:-5432}:5432');
    expect(content).toContain('${SAIL_MAILPIT_SMTP_PORT:-1025}:1025');
    expect(content).toContain('${SAIL_MAILPIT_UI_PORT:-8025}:8025');
  });

  it('declares named volumes for stateful services only', () => {
    const content = generateComposeFile(['postgres', 'mailpit']);
    expect(content).toContain('sail-postgres:');
    expect(content).not.toContain('sail-mailpit');
  });

  it('round-trips through servicesInComposeFile', () => {
    expect(servicesInComposeFile(generateComposeFile(['redis', 'minio']))).toEqual([
      'redis',
      'minio',
    ]);
  });
});

describe('mergeComposeFile', () => {
  it('appends missing services and reports them', () => {
    const { content, added } = mergeComposeFile(generateComposeFile(['postgres']), ['redis']);
    expect(added).toEqual(['redis']);
    expect(servicesInComposeFile(content)).toEqual(['postgres', 'redis']);
  });

  it('leaves existing services (and hand edits) untouched', () => {
    const customized = generateComposeFile(['postgres']).replace('postgres:17', 'postgres:16');
    const { content, added } = mergeComposeFile(customized, ['postgres', 'redis']);
    expect(added).toEqual(['redis']);
    expect(content).toContain('postgres:16');
  });

  it('is a no-op when everything is already present', () => {
    const existing = generateComposeFile(['postgres']);
    const { added } = mergeComposeFile(existing, ['postgres']);
    expect(added).toEqual([]);
  });
});

describe('object storage fragments', () => {
  it('adds the config Garage mounts, once, when merged into an existing file', () => {
    const { content } = mergeComposeFile(generateComposeFile(['postgres']), ['garage']);
    expect(content).toContain('sail-garage-toml:');
    expect(content).toContain('content: |');
    expect(content).toContain('target: /etc/garage.toml');
    expect(mergeComposeFile(content, ['garage']).content).toBe(content);
  });

  it('writes the image a caller picks for a new service only', () => {
    const fresh = generateComposeFile(['postgres'], {
      images: { postgres: 'pgvector/pgvector:pg17' },
    });
    expect(serviceImageInComposeFile(fresh, 'postgres')).toBe('pgvector/pgvector:pg17');

    const kept = mergeComposeFile(generateComposeFile(['postgres']), ['postgres'], {
      images: { postgres: 'pgvector/pgvector:pg17' },
    });
    expect(serviceImageInComposeFile(kept.content, 'postgres')).toBe('postgres:17');
  });

  it('keeps a command string for MinIO and an argv list for Garage', () => {
    const content = generateComposeFile(['minio', 'garage']);
    expect(content).toContain('command: server /data --console-address ":8900"');
    expect(content).toMatch(/command:\n {6}- \/garage\n {6}- server/);
  });
});
