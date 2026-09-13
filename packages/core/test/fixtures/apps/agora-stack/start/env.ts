/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Variables for configuring session package
  |----------------------------------------------------------
  */
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory', 'redis'] as const),

  /*
  |----------------------------------------------------------
  | Variables for configuring database connection
  |----------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the mail package
  |----------------------------------------------------------
  */
  ENTRETEXTOS_RESEND_API_KEY: Env.schema.string(),
  EMAIL_FROM: Env.schema.string(),
  SMTP_HOST: Env.schema.string({ format: 'host' }),
  SMTP_PORT: Env.schema.number(),
  SMTP_USER: Env.schema.string(),
  SMTP_PASSWORD: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the drive package
  |----------------------------------------------------------
  | O disco 's3' aponta para o MinIO em dev e para o bucket de verdade em
  | produção. Quem decide é `USING_MINIO`: ligado, `config/drive.ts` (e o
  | `disks.s3` espelhado em `config/media.ts`) acrescentam `endpoint:
  | MINIO_URL` + `forcePathStyle: true` ao cliente S3. Note que a env do
  | endpoint chama-se MINIO_URL e NÃO S3_ENDPOINT: o stub do @adonisjs/drive
  | não tem campo de endpoint, então o nome foi escolhido aqui, na mão, quando
  | o MinIO entrou — trocar agora invalidaria os dois ambientes já implantados.
  */
  DRIVE_DISK: Env.schema.enum(['fs', 's3'] as const),

  AWS_ACCESS_KEY_ID: Env.schema.string(),
  AWS_SECRET_ACCESS_KEY: Env.schema.string(),
  AWS_REGION: Env.schema.string(),
  S3_BUCKET: Env.schema.string(),
  USING_MINIO: Env.schema.boolean(),
  MINIO_URL: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring the lock package
  |----------------------------------------------------------
  */
  LOCK_STORE: Env.schema.enum(['redis', 'memory'] as const),

  /*
  |----------------------------------------------------------
  | Variables for configuring Redis + Transmit (realtime/SSE)
  |----------------------------------------------------------
  | TRANSMIT_TRANSPORT controls whether realtime events are
  | broadcast in-memory (single instance) or via Redis (multi
  | instance). When 'redis', the REDIS_* vars must be set.
  */
  TRANSMIT_TRANSPORT: Env.schema.enum.optional(['memory', 'redis'] as const),
  REDIS_HOST: Env.schema.string.optional({ format: 'host' }),
  REDIS_PORT: Env.schema.number.optional(),
  REDIS_PASSWORD: Env.schema.string.optional(),

  /*
  |----------------------------------------------------------
  | Store do @adonisjs/limiter (`redis` conexão `main`, namespaceada por
  | keyPrefix; `memory` para dev single-instance) e driver do @adonisjs/queue
  | (`redis` conexão `main`; `sync` para dev/testes, executa inline).
  */
  LIMITER_STORE: Env.schema.enum(['redis', 'memory'] as const),
  QUEUE_DRIVER: Env.schema.enum(['redis', 'sync'] as const),

  /*
  |----------------------------------------------------------
  | Telescope
  |----------------------------------------------------------
  */
  TELESCOPE_ENABLED: Env.schema.string.optional(),
})
