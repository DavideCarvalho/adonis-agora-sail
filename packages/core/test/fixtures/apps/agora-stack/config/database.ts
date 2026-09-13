import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'
import app from '@adonisjs/core/services/app'

/**
 * ⚠️ NENHUMA conexão declara `searchPath` nem emite `SET search_path`
 * (`pool.afterCreate`, provider, `options=-c ...`). Não reintroduza.
 *
 * Produção fica atrás de um PgBouncer em modo *transaction*: a conexão física
 * do servidor é revezada entre clientes a cada transação e NÃO é resetada no
 * release. Um `SET search_path` de sessão emitido por um cliente vaza para o
 * próximo que pegar aquela conexão. Em 2026-08-29 isso derrubou o site por
 * ~15h: o `afterCreate` da conexão `auth` emitia `set search_path to "auth",
 * "public"` em toda conexão nova; o valor vazava para queries da conexão
 * `entretextos` e tudo fora de `auth`/`public` morria com `42P01 relation ...
 * does not exist`.
 *
 * O que resolve o `search_path` agora é o DEFAULT DO ROLE no servidor
 * (`ALTER ROLE <dbuser> SET search_path = entretextos, auth, public`): vale
 * para toda conexão, sem `SET` do cliente, e por isso não tem o que vazar.
 *
 * Becos sem saída já testados (não repetir): `options=-c search_path=...` na
 * connection string (PgBouncer rejeita), `migrations.tableName` qualificado
 * (`hasTable` devolve false), role separado para auth (todas as sessões chegam
 * como o mesmo `session_user`).
 */

// Opção do knex 3.3.0 (não tipada no PoolConfig do Lucid): recicla conexões do
// pool após o lifetime. Mantida fora do literal do pool para o spread não
// disparar o excess property check do TypeScript.
const connectionLifetime = {
  maxConnectionLifetimeMillis: 30 * 60 * 1000,
}

const connection = {
  host: env.get('DB_HOST'),
  port: env.get('DB_PORT'),
  user: env.get('DB_USER'),
  password: env.get('DB_PASSWORD'),
  database: env.get('DB_DATABASE'),
}

const dbConfig = defineConfig({
  connection: 'entretextos',
  prettyPrintDebugQueries: app.inDev,
  connections: {
    // Conexão principal do app (default). Migrations em `database/migrations/entretextos`.
    entretextos: {
      client: 'pg',
      connection,
      pool: {
        min: 1,
        max: 20,
        ...connectionLifetime,
      },
      migrations: { naturalSort: true, paths: ['database/migrations/entretextos'] },
      // SEMPRE ligado: o Lucid só emite `db:query` numa conexão com `debug`, e sem
      // esse evento o watcher `query` do telescope não grava nada.
      debug: true,
    },
    // Conexão do schema `auth` compartilhado — usada pelo @adonis-agora/authkit-server.
    auth: {
      client: 'pg',
      connection,
      pool: {
        min: 1,
        max: 5,
        ...connectionLifetime,
      },
      migrations: { naturalSort: true, paths: ['database/migrations/auth'] },
      debug: app.inDev,
    },
    /**
     * Conexão EXCLUSIVA do store do telescope. Com `debug` ligado na conexão
     * principal, o Lucid emite `db:query` para TODA query dela — inclusive os
     * INSERTs que o próprio telescope faz em `telescope_entries`.
     */
    telescope: {
      client: 'pg',
      connection,
      pool: {
        min: 1,
        max: 5,
        ...connectionLifetime,
      },
      debug: false,
    },
  },
})

export default dbConfig
