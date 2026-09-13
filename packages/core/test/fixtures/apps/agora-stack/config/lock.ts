import env from '#start/env'
import { defineConfig, stores } from '@adonisjs/lock'

const lockConfig = defineConfig({
  default: env.get('LOCK_STORE'),
  stores: {
    /**
     * Redis store (conexão `main`, keyPrefix 'entretextos:' → namespaceado).
     */
    redis: stores.redis({
      connectionName: 'main',
    }),

    /**
     * Memory store could be used during
     * testing
     */
    memory: stores.memory(),
  },
})

export default lockConfig

declare module '@adonisjs/lock/types' {
  export interface LockStoresList extends InferLockStores<typeof lockConfig> {}
}
