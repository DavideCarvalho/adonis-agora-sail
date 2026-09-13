import env from '#start/env'
import { defineConfig, drivers, exponentialBackoff } from '@adonisjs/queue'

export default defineConfig({
  default: env.get('QUEUE_DRIVER'),

  adapters: {
    redis: drivers.redis({
      connectionName: 'main',
    }),
    sync: drivers.sync(),
  },

  retry: {
    maxRetries: 3,
    backoff: exponentialBackoff({ baseDelay: '1s', maxDelay: '5m', jitter: true }),
  },

  worker: {
    concurrency: 3,
    gracefulShutdown: true,
  },

  locations: ['./app/**/jobs/**/*.{ts,js}', './start/jobs/**/*.{ts,js}'],
})
