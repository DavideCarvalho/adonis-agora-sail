import { describe, expect, it } from 'vitest';

import { detectServicesFromDependencies } from '../src/detect.js';

describe('detectServicesFromDependencies', () => {
  it('returns an empty list when nothing matches', () => {
    expect(detectServicesFromDependencies({})).toEqual([]);
    expect(detectServicesFromDependencies({ '@adonisjs/core': '^7.0.0' })).toEqual([]);
  });

  it('detects postgres from the pg driver', () => {
    expect(detectServicesFromDependencies({ pg: '^8.0.0' })).toEqual(['postgres']);
  });

  it('detects mysql from mysql2', () => {
    expect(detectServicesFromDependencies({ mysql2: '^3.0.0' })).toEqual(['mysql']);
  });

  it('prefers postgres when both drivers are present', () => {
    expect(detectServicesFromDependencies({ pg: '^8.0.0', mysql2: '^3.0.0' })).toEqual([
      'postgres',
    ]);
  });

  it('detects redis, mailpit and minio from their packages', () => {
    expect(
      detectServicesFromDependencies({
        '@adonisjs/redis': '^3.0.0',
        '@adonisjs/mail': '^9.0.0',
        '@adonisjs/drive': '^3.0.0',
      }),
    ).toEqual(['redis', 'mailpit', 'minio']);
  });

  it('detects queue and s3-adjacent packages too', () => {
    expect(detectServicesFromDependencies({ bullmq: '^5.0.0' })).toEqual(['redis']);
    expect(detectServicesFromDependencies({ '@aws-sdk/client-s3': '^3.0.0' })).toEqual(['minio']);
  });
});
