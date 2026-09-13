import env from '#start/env'
import { defineConfig } from '@adonisjs/redis'
import { type InferConnections } from '@adonisjs/redis/types'

/**
 * Configuração do Redis.
 *
 * `keyPrefix: 'entretextos:'` namespaceia TODAS as chaves desta conexão. Como
 * entre-textos e eduliberta compartilham a mesma instância Redis, o prefixo
 * evita que as chaves de um app colidam com as do outro (rate-limit, cache…).
 */
const redisConfig = defineConfig({
  connection: 'main',

  connections: {
    main: {
      host: env.get('REDIS_HOST'),
      port: env.get('REDIS_PORT'),
      password: env.get('REDIS_PASSWORD', ''),
      keyPrefix: 'entretextos:',
      retryStrategy(times) {
        return times > 10 ? null : times * 50
      },
    },
  },
})

export default redisConfig

declare module '@adonisjs/redis/types' {
  export interface RedisConnections extends InferConnections<typeof redisConfig> {}
}
