import { describe, expect, it } from 'vitest';

import {
  DEFAULT_S3_ENV_NAMES,
  parseRequiredEnvKeys,
  parseS3DiskConfig,
  serviceAppEnv,
} from '../src/app_env.js';
import { stripComments } from '../src/app_scan.js';

describe('parseS3DiskConfig', () => {
  it('returns null when there is no s3 disk', () => {
    expect(parseS3DiskConfig(`services: { fs: services.fs({ location: 'x' }) }`)).toBeNull();
  });

  it('reads the env keys each property takes, and nulls literals', () => {
    const disk = parseS3DiskConfig(
      stripComments(`services: {
  s3: services.s3({
    credentials: {
      accessKeyId: env.get('S3_ACCESS_KEY'),
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    region: 'sa-east-1',
    bucket: env.get("S3_BUCKET_NAME", 'fallback'),
    // endpoint: env.get('COMMENTED_OUT'),
    visibility: 'public',
  }),
}`),
    );
    expect(disk).toEqual({
      names: {
        accessKeyId: 'S3_ACCESS_KEY',
        secretAccessKey: 'S3_SECRET_KEY',
        region: null,
        bucket: 'S3_BUCKET_NAME',
        endpoint: 'S3_ENDPOINT',
        forcePathStyle: null,
      },
      endpointConfigured: false,
      forcePathStyleConfigured: false,
    });
  });

  it('stops at the end of the s3 call, ignoring the disks after it', () => {
    const disk = parseS3DiskConfig(`s3: services.s3({ bucket: env.get('A') }),
gcs: services.gcs({ bucket: env.get('B'), endpoint: env.get('GCS_URL') })`);
    expect(disk?.names.bucket).toBe('A');
    expect(disk?.endpointConfigured).toBe(false);
  });

  it('sees endpoint and forcePathStyle set inside a conditional spread', () => {
    const disk = parseS3DiskConfig(`s3: services.s3({
  bucket: env.get('S3_BUCKET'),
  ...(env.get('USING_MINIO') ? { endpoint: env.get('MINIO_URL'), forcePathStyle: true } : {}),
})`);
    expect(disk?.names.endpoint).toBe('MINIO_URL');
    expect(disk?.endpointConfigured).toBe(true);
    expect(disk?.forcePathStyleConfigured).toBe(true);
    expect(disk?.names.forcePathStyle).toBeNull();
  });
});

describe('parseRequiredEnvKeys', () => {
  it('lists declarations without .optional', () => {
    expect(
      parseRequiredEnvKeys(`{
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PASSWORD: Env.schema.string.optional(),
  S3_KEY: Env.schema.string(),
  PORT: Env.schema.number(),
}`),
    ).toEqual(['REDIS_HOST', 'S3_KEY', 'PORT']);
  });
});

describe('serviceAppEnv', () => {
  const ports = { SAIL_RUSTFS_PORT: 9100, SAIL_RUSTFS_CONSOLE_PORT: 9101 };

  it('uses the stock keys by default', () => {
    expect(serviceAppEnv('rustfs', ports)).toEqual({
      AWS_ACCESS_KEY_ID: 'sail',
      AWS_SECRET_ACCESS_KEY: 'password',
      AWS_REGION: 'us-east-1',
      S3_BUCKET: 'local',
      S3_ENDPOINT: 'http://127.0.0.1:9100',
    });
  });

  it('renames object storage keys and drops the ones the disk does not read', () => {
    expect(
      serviceAppEnv('rustfs', ports, {
        s3EnvNames: {
          ...DEFAULT_S3_ENV_NAMES,
          accessKeyId: 'S3_KEY',
          region: null,
          forcePathStyle: 'S3_PATH_STYLE',
        },
      }),
    ).toEqual({
      S3_KEY: 'sail',
      AWS_SECRET_ACCESS_KEY: 'password',
      S3_BUCKET: 'local',
      S3_ENDPOINT: 'http://127.0.0.1:9100',
      S3_PATH_STYLE: 'true',
    });
  });

  it('never renames the keys of other services', () => {
    const env = serviceAppEnv(
      'postgres',
      { SAIL_POSTGRES_PORT: 5432 },
      { s3EnvNames: { ...DEFAULT_S3_ENV_NAMES, accessKeyId: 'X' } },
    );
    expect(env['DB_USER']).toBe('sail');
    expect(env['DB_PASSWORD']).toBe('password');
  });

  it('writes an empty REDIS_PASSWORD unless start/env.ts requires it', () => {
    expect(serviceAppEnv('redis', { SAIL_REDIS_PORT: 6379 })).toMatchObject({
      REDIS_PASSWORD: '',
    });
    expect(
      serviceAppEnv('redis', { SAIL_REDIS_PORT: 6379 }, { requiredEnvKeys: ['REDIS_PASSWORD'] }),
    ).not.toHaveProperty('REDIS_PASSWORD');
  });

  it('gives Garage the credentials it accepts', () => {
    const env = serviceAppEnv('garage', { SAIL_GARAGE_PORT: 3900 });
    expect((env['AWS_ACCESS_KEY_ID'] ?? '').length).toBeGreaterThanOrEqual(8);
    expect((env['AWS_SECRET_ACCESS_KEY'] ?? '').length).toBeGreaterThanOrEqual(16);
    expect(env['AWS_REGION']).toBe('us-east-1');
  });
});
