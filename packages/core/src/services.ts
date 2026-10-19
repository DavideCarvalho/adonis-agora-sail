import type { ObjectStorageBackend, SailServiceDefinition, SailServiceName } from './types.js';

/**
 * Fixed development credentials, Laravel Sail style: predictable on purpose so
 * `sail:install` needs zero configuration. Never use these outside local dev.
 */
export const SAIL_USER = 'sail';
export const SAIL_PASSWORD = 'password';
export const SAIL_DATABASE = 'app';
/** The bucket every object storage backend serves, created on `sail:up`. */
export const SAIL_BUCKET = 'local';
/** The signing region every object storage backend expects. */
export const SAIL_REGION = 'us-east-1';

/**
 * Garage rejects `sail` / `password`: imported access key ids need at least 8
 * characters and secrets at least 16. Still fixed, still dev-only.
 */
export const GARAGE_ACCESS_KEY = 'sail-garage-key';
export const GARAGE_SECRET_KEY = 'sail-garage-password';
/** Node-to-node secret of a one-node Garage cluster: never leaves the container. */
const GARAGE_RPC_SECRET = '5a11'.repeat(16);

/**
 * The app-side env an AdonisJS `s3` disk reads, under the stock key names.
 * `sail:install` / `sail:up` rename them to the keys the app's own
 * `config/drive.ts` reads (see `S3EnvNames` in `app_env.ts`).
 */
function objectStorageEnv(
  accessKeyId: string,
  secretAccessKey: string,
  endpoint: string,
): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_REGION: SAIL_REGION,
    S3_BUCKET: SAIL_BUCKET,
    S3_ENDPOINT: endpoint,
  };
}

/**
 * The catalog of services sail can run. Every host port goes through a
 * `${VAR:-base}` interpolation so the committed compose file is identical in
 * every worktree — sail injects the worktree-offset ports at runtime, and a
 * bare `docker compose up` still works with the defaults.
 */
export const SERVICES: Record<SailServiceName, SailServiceDefinition> = {
  postgres: {
    name: 'postgres',
    summary: 'PostgreSQL 17 database',
    image: 'postgres:17',
    ports: [
      { envVar: 'SAIL_POSTGRES_PORT', basePort: 5432, containerPort: 5432, label: 'postgres' },
    ],
    environment: {
      POSTGRES_USER: SAIL_USER,
      POSTGRES_PASSWORD: SAIL_PASSWORD,
      POSTGRES_DB: SAIL_DATABASE,
    },
    volumes: ['sail-postgres:/var/lib/postgresql/data'],
    healthcheck: {
      test: ['CMD', 'pg_isready', '-U', SAIL_USER, '-d', SAIL_DATABASE],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    detectedBy: ['pg'],
    appEnv: (ports) => ({
      DB_HOST: '127.0.0.1',
      DB_PORT: String(ports['SAIL_POSTGRES_PORT']),
      DB_USER: SAIL_USER,
      DB_PASSWORD: SAIL_PASSWORD,
      DB_DATABASE: SAIL_DATABASE,
    }),
    dashboards: () => [],
  },

  mysql: {
    name: 'mysql',
    summary: 'MySQL 8 database',
    image: 'mysql:8',
    ports: [{ envVar: 'SAIL_MYSQL_PORT', basePort: 3306, containerPort: 3306, label: 'mysql' }],
    environment: {
      MYSQL_USER: SAIL_USER,
      MYSQL_PASSWORD: SAIL_PASSWORD,
      MYSQL_DATABASE: SAIL_DATABASE,
      MYSQL_ROOT_PASSWORD: SAIL_PASSWORD,
    },
    volumes: ['sail-mysql:/var/lib/mysql'],
    healthcheck: {
      test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', `-p${SAIL_PASSWORD}`],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    detectedBy: ['mysql2', 'mysql'],
    appEnv: (ports) => ({
      DB_HOST: '127.0.0.1',
      DB_PORT: String(ports['SAIL_MYSQL_PORT']),
      DB_USER: SAIL_USER,
      DB_PASSWORD: SAIL_PASSWORD,
      DB_DATABASE: SAIL_DATABASE,
    }),
    dashboards: () => [],
  },

  redis: {
    name: 'redis',
    summary: 'Redis 7 cache / queue store',
    image: 'redis:7-alpine',
    ports: [{ envVar: 'SAIL_REDIS_PORT', basePort: 6379, containerPort: 6379, label: 'redis' }],
    environment: {},
    volumes: ['sail-redis:/data'],
    healthcheck: {
      test: ['CMD', 'redis-cli', 'ping'],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    detectedBy: ['@adonisjs/redis', 'ioredis', 'bullmq'],
    appEnv: (ports) => ({
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(ports['SAIL_REDIS_PORT']),
      // Sail's Redis runs without auth. Blanking the password in .env.local
      // keeps a production REDIS_PASSWORD from .env from being sent to it.
      REDIS_PASSWORD: '',
    }),
    dashboards: () => [],
  },

  mailpit: {
    name: 'mailpit',
    summary: 'Mailpit SMTP catcher with a web inbox',
    image: 'axllent/mailpit:latest',
    ports: [
      { envVar: 'SAIL_MAILPIT_SMTP_PORT', basePort: 1025, containerPort: 1025, label: 'smtp' },
      { envVar: 'SAIL_MAILPIT_UI_PORT', basePort: 8025, containerPort: 8025, label: 'ui' },
    ],
    environment: {},
    volumes: [],
    detectedBy: ['@adonisjs/mail'],
    appEnv: (ports) => ({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(ports['SAIL_MAILPIT_SMTP_PORT']),
    }),
    dashboards: (ports) => [
      { label: 'Mailpit inbox', url: `http://localhost:${ports['SAIL_MAILPIT_UI_PORT']}` },
    ],
  },

  rustfs: {
    name: 'rustfs',
    summary: 'RustFS S3-compatible object storage',
    image: 'rustfs/rustfs:1.0.3',
    ports: [
      { envVar: 'SAIL_RUSTFS_PORT', basePort: 9000, containerPort: 9000, label: 's3' },
      { envVar: 'SAIL_RUSTFS_CONSOLE_PORT', basePort: 9001, containerPort: 9001, label: 'console' },
    ],
    environment: {
      RUSTFS_ACCESS_KEY: SAIL_USER,
      RUSTFS_SECRET_KEY: SAIL_PASSWORD,
      RUSTFS_CONSOLE_ENABLE: 'true',
    },
    volumes: ['sail-rustfs:/data'],
    healthcheck: {
      test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:9000/health'],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    // RustFS has no env var that creates a bucket. The image ships curl with
    // SigV4 support, so one signed PUT does it; RustFS answers 200 to a PUT
    // on a bucket the caller already owns, which makes it safe on every `up`.
    bootstrap: {
      description: `create the '${SAIL_BUCKET}' bucket`,
      command: [
        'sh',
        '-c',
        `curl -fsS -o /dev/null --aws-sigv4 'aws:amz:${SAIL_REGION}:s3' --user "$RUSTFS_ACCESS_KEY:$RUSTFS_SECRET_KEY" -X PUT http://127.0.0.1:9000/${SAIL_BUCKET}`,
      ],
    },
    detectedBy: [],
    appEnv: (ports) =>
      objectStorageEnv(SAIL_USER, SAIL_PASSWORD, `http://127.0.0.1:${ports['SAIL_RUSTFS_PORT']}`),
    dashboards: (ports) => [
      {
        label: 'RustFS console',
        url: `http://localhost:${ports['SAIL_RUSTFS_CONSOLE_PORT']}/rustfs/console/`,
      },
    ],
  },

  seaweedfs: {
    name: 'seaweedfs',
    summary: 'SeaweedFS S3-compatible object storage (weed mini)',
    image: 'chrislusf/seaweedfs:4.48',
    ports: [
      { envVar: 'SAIL_SEAWEEDFS_PORT', basePort: 8333, containerPort: 8333, label: 's3' },
      { envVar: 'SAIL_SEAWEEDFS_FILER_PORT', basePort: 8888, containerPort: 8888, label: 'filer' },
    ],
    // The image's default command is `weed mini -dir=/data` (master, volume,
    // filer and S3 in one process). These three variables give the S3 API an
    // admin identity and create the bucket — idempotently, on every start.
    environment: {
      AWS_ACCESS_KEY_ID: SAIL_USER,
      AWS_SECRET_ACCESS_KEY: SAIL_PASSWORD,
      S3_BUCKET: SAIL_BUCKET,
    },
    volumes: ['sail-seaweedfs:/data'],
    healthcheck: {
      test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:8333/healthz'],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    detectedBy: [],
    appEnv: (ports) =>
      objectStorageEnv(
        SAIL_USER,
        SAIL_PASSWORD,
        `http://127.0.0.1:${ports['SAIL_SEAWEEDFS_PORT']}`,
      ),
    dashboards: (ports) => [
      {
        label: 'SeaweedFS filer',
        url: `http://localhost:${ports['SAIL_SEAWEEDFS_FILER_PORT']}/buckets/`,
      },
    ],
  },

  garage: {
    name: 'garage',
    summary: 'Garage S3-compatible object storage',
    image: 'dxflrs/garage:v2.4.1',
    ports: [{ envVar: 'SAIL_GARAGE_PORT', basePort: 3900, containerPort: 3900, label: 's3' }],
    // Single-node mode (Garage 2.3+) bootstraps the cluster layout, imports
    // the access key and creates the bucket at boot, and skips each step
    // that is already done — so every `up` is idempotent with no exec step.
    command: ['/garage', 'server', '--single-node', '--default-bucket'],
    environment: {
      GARAGE_DEFAULT_ACCESS_KEY: GARAGE_ACCESS_KEY,
      GARAGE_DEFAULT_SECRET_KEY: GARAGE_SECRET_KEY,
      GARAGE_DEFAULT_BUCKET: SAIL_BUCKET,
    },
    configs: [
      {
        name: 'sail-garage-toml',
        target: '/etc/garage.toml',
        content: [
          'metadata_dir = "/var/lib/garage/meta"',
          'data_dir = "/var/lib/garage/data"',
          'db_engine = "sqlite"',
          'replication_factor = 1',
          'rpc_bind_addr = "[::]:3901"',
          'rpc_public_addr = "127.0.0.1:3901"',
          `rpc_secret = "${GARAGE_RPC_SECRET}"`,
          '',
          '[s3_api]',
          // Garage checks the signing region strictly; matching every other
          // backend keeps AWS_REGION identical whichever one runs.
          `s3_region = "${SAIL_REGION}"`,
          'api_bind_addr = "[::]:3900"',
          '',
        ].join('\n'),
      },
    ],
    volumes: ['sail-garage:/var/lib/garage'],
    // The image is FROM scratch: no shell, no curl. Its own CLI is the probe.
    healthcheck: {
      test: ['CMD', '/garage', 'status'],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    detectedBy: [],
    appEnv: (ports) =>
      objectStorageEnv(
        GARAGE_ACCESS_KEY,
        GARAGE_SECRET_KEY,
        `http://127.0.0.1:${ports['SAIL_GARAGE_PORT']}`,
      ),
    dashboards: () => [],
  },

  minio: {
    name: 'minio',
    summary: 'MinIO S3-compatible object storage',
    // minio/minio is no longer published on Docker Hub: MinIO stopped
    // shipping community images in October 2025 and archived the repository
    // in April 2026. Chainguard rebuilds it from source, free, as `latest`.
    image: 'cgr.dev/chainguard/minio:latest',
    ports: [
      { envVar: 'SAIL_MINIO_PORT', basePort: 9000, containerPort: 9000, label: 's3' },
      { envVar: 'SAIL_MINIO_CONSOLE_PORT', basePort: 8900, containerPort: 8900, label: 'console' },
    ],
    command: 'server /data --console-address ":8900"',
    environment: {
      MINIO_ROOT_USER: SAIL_USER,
      MINIO_ROOT_PASSWORD: SAIL_PASSWORD,
    },
    volumes: ['sail-minio:/data'],
    healthcheck: {
      test: ['CMD', 'mc', 'ready', 'local'],
      interval: '5s',
      timeout: '5s',
      retries: 10,
    },
    bootstrap: {
      description: `create the '${SAIL_BUCKET}' bucket`,
      command: [
        'sh',
        '-c',
        `mc alias set sail http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing sail/${SAIL_BUCKET} >/dev/null`,
      ],
    },
    detectedBy: [],
    appEnv: (ports) =>
      objectStorageEnv(SAIL_USER, SAIL_PASSWORD, `http://localhost:${ports['SAIL_MINIO_PORT']}`),
    dashboards: (ports) => [
      { label: 'MinIO console', url: `http://localhost:${ports['SAIL_MINIO_CONSOLE_PORT']}` },
    ],
  },
};

/**
 * Object storage backends, in catalog order. Exactly one fills a stack's
 * object storage slot.
 */
export const OBJECT_STORAGE_BACKENDS: ObjectStorageBackend[] = [
  'rustfs',
  'seaweedfs',
  'garage',
  'minio',
];

/**
 * The backend new installs get when nothing says otherwise. RustFS: Apache-2.0,
 * actively maintained, the smallest step from MinIO (same port layout, a web
 * console, `sail`/`password` credentials) and ~30 MB of RAM idle. The README
 * has the full comparison.
 */
export const DEFAULT_OBJECT_STORAGE: ObjectStorageBackend = 'rustfs';

/**
 * Dependencies that imply object storage. They select the slot, not a backend:
 * which backend fills it is a preference (`--object-storage`, `package.json`
 * `sail.objectStorage`), not something a dependency can tell.
 */
export const OBJECT_STORAGE_DEPENDENCIES = ['@adonisjs/drive', 'flydrive', '@aws-sdk/client-s3'];

export function isObjectStorageBackend(value: string): value is ObjectStorageBackend {
  return (OBJECT_STORAGE_BACKENDS as string[]).includes(value);
}

export const SERVICE_NAMES = Object.keys(SERVICES) as SailServiceName[];

export function isServiceName(value: string): value is SailServiceName {
  return value in SERVICES;
}
