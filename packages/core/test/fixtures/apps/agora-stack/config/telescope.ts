import env from '#start/env'
import { defineConfig, storage } from '@adonis-agora/telescope'
import { durableTelescopeExtension } from '@adonis-agora/durable/telescope'

/**
 * Núcleo do telescope. Storage lucid persistente numa conexão DEDICADA, cujo
 * `searchPath` inclui `public` no fim — a tabela `telescope_entries` vive em
 * `public` (observabilidade fora do schema de domínio). A tabela é criada pelo
 * próprio store (`autoCreateTable`) na primeira gravação, em todos os
 * ambientes — sem migration (a lib gerencia o próprio schema).
 *
 * `TELESCOPE_ENABLED` permite desligar o watcher durante o `migration:run`:
 * sem ele, o telescope grava `telescope_entries` ao MESMO tempo que as
 * migrations rodam e o pool de conexões (min 1 / max 5) exaure.
 */
export default defineConfig({
  enabled: env.get('TELESCOPE_ENABLED', 'true') === 'true',
  store: 'lucid',
  stores: {
    // Conexão DEDICADA (ver config/database.ts): a principal tem `debug: true` para
    // alimentar o watcher de query, e gravar aqui por ela faria cada entry do
    // telescope gerar outra entry, sem limite.
    lucid: storage.lucid({ connection: 'telescope', autoCreateTable: true }),
  },
  watchers: ['request', 'diagnostics', 'logs'],
  extensions: [durableTelescopeExtension()],
  prune: { after: '72h', intervalMs: 3_600_000 },
  clientErrors: {
    enabled: true,
  },
})
