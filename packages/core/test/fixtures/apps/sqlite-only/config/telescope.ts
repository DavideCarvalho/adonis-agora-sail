import { defineConfig, storage } from '@adonis-agora/telescope'

/**
 * Configuration for '@adonis-agora/telescope'. Everything is optional — the defaults
 * use the in-memory store with the 'request' and 'diagnostics' watchers enabled and
 * a 1000-entry cap.
 */
export default defineConfig({
  /**
   * Master switch. Set to false to disable all recording (zero overhead).
   */
  // enabled: true,

  /**
   * Which named store backs telescope. The active driver is selected by 'store'
   * and built from the 'stores' map below.
   */
  store: 'memory',

  /**
   * Named store drivers, built with the 'storage' factory. Each is a lazy thunk —
   * its peer dependency is only imported when that driver is the active one.
   *
   * To persist entries across restarts, install '@adonisjs/lucid', run the
   * migration this package publishes (or pass autoCreateTable: true), switch
   * 'store' to 'lucid', and uncomment the lucid driver:
   */
  stores: {
    memory: storage.memory({ limit: 1000 }),
    // lucid: storage.lucid({ connection: 'pg' }),
  },

  /**
   * Active watchers. Omit one to disable it.
   *  - 'request'     — records each HTTP request (method, url, status, duration).
   *  - 'diagnostics' — records every diagnostics-bus publish from a sibling Agora lib.
   *  - 'logs'        — tees the AdonisJS logger and records each line as a 'log' entry.
   */
  // watchers: ['request', 'diagnostics'],

  /**
   * Background retention. A pruner deletes stale entries on a timer so the store
   * never grows without bound. OFF unless this block is present.
   */
  // prune: {
  //   after: '24h',
  //   // keepLast: 10000,
  //   // intervalMs: 60_000,
  // },

  /**
   * OTel export — ships every already-captured `diagnostic` entry as OTLP
   * spans/logs to a Collector. Left OFF here on purpose: this example runs on
   * SQLite with zero external infra, and turning this on with no Collector
   * listening would make every diagnostic entry wait out `timeoutMs` before
   * giving up.
   */
  // otel: {
  //   enabled: true,
  //   endpoint: 'http://localhost:4318',
  //   serviceName: 'end-to-end-example',
  // },
})
