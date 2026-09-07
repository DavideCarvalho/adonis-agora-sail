import type { SailServiceDefinition, SailServiceName } from './types.js';

/**
 * Fixed development credentials, Laravel Sail style: predictable on purpose so
 * `sail:install` needs zero configuration. Never use these outside local dev.
 */
export const SAIL_USER = 'sail';
export const SAIL_PASSWORD = 'password';
export const SAIL_DATABASE = 'app';

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

  minio: {
    name: 'minio',
    summary: 'MinIO S3-compatible object storage',
    image: 'minio/minio:latest',
    ports: [
      { envVar: 'SAIL_MINIO_PORT', basePort: 9000, containerPort: 9000, label: 's3' },
      { envVar: 'SAIL_MINIO_CONSOLE_PORT', basePort: 8900, containerPort: 8900, label: 'console' },
    ],
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
    detectedBy: ['@adonisjs/drive', 'flydrive', '@aws-sdk/client-s3'],
    appEnv: (ports) => ({
      AWS_ACCESS_KEY_ID: SAIL_USER,
      AWS_SECRET_ACCESS_KEY: SAIL_PASSWORD,
      AWS_REGION: 'us-east-1',
      S3_BUCKET: 'local',
      S3_ENDPOINT: `http://localhost:${ports['SAIL_MINIO_PORT']}`,
    }),
    dashboards: (ports) => [
      { label: 'MinIO console', url: `http://localhost:${ports['SAIL_MINIO_CONSOLE_PORT']}` },
    ],
  },
};

/**
 * Extra container config that does not fit the generic shape, keyed by
 * service. Kept here so the compose generator stays data-driven.
 */
export const SERVICE_COMMANDS: Partial<Record<SailServiceName, string>> = {
  minio: 'server /data --console-address ":8900"',
};

export const SERVICE_NAMES = Object.keys(SERVICES) as SailServiceName[];

export function isServiceName(value: string): value is SailServiceName {
  return value in SERVICES;
}
