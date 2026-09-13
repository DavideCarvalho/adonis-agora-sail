import { defineConfig, stores, transports } from '@adonis-agora/durable'

/**
 * The library's default store is IN-MEMORY: `durable: true` with it does not survive a
 * restart, and the agent's pending approval would die on deploy exactly as under the
 * inline runner — only silently. The lucid store is what makes durability real.
 *
 * The connection is explicit because the app has three: the driver's default is the
 * Database facade's default connection, NOT the domain one.
 *
 * In-process transport: the app is single-process. `memory` is test-only (per the lib's
 * own docs); `event-emitter` is the production equivalent, with no DB, Redis, or broker.
 */
export default defineConfig({
  transport: 'event-emitter',
  transports: {
    'event-emitter': transports.eventEmitter(),
  },
  store: 'lucid',
  stores: {
    lucid: stores.lucid({ connection: 'entretextos' }),
  },
})
