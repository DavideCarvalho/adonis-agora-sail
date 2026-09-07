# `@adonis-agora/sail`

Docker-powered local dev services for AdonisJS. Sail runs Postgres, MySQL,
Redis, Mailpit and MinIO in Docker while the app itself stays on the host —
and every git worktree gets isolated containers with deterministic,
shifted host ports, automatically.

```bash
node ace add @adonis-agora/sail
node ace sail:install   # scan the app, generate compose.yml, wire env.ts + .env
node ace sail:up        # start the stack, wait for healthchecks, sync .env.local
```

```bash
node ace sail:info              # ports, dashboards and connection env (or --json / --env)
node ace sail:ps                # container state, health, published ports
node ace sail:psql              # psql REPL — or -- -c 'select 1' (also sail:mysql, sail:redis)
node ace sail:logs redis --tail 100
node ace sail:exec redis -- redis-cli ping
node ace sail:share             # public tunnel URL for previews and webhooks
node ace sail:down              # stop this worktree's stack
node ace sail:prune --dry-run   # stacks left behind by deleted worktrees
```

### How it works

`install` detects services from `package.json` **and** `config/*.ts`
(`client: 'pg'`, `config/redis.ts`, smtp mailers, s3 disks, active
`store: 'lucid'` selections in Agora configs — commented-out alternatives
are ignored, and a dependency contradicted by its config is skipped with a
note). It writes a worktree-agnostic `compose.yml` (host ports interpolate
`${SAIL_*_PORT:-base}`), appends the missing `start/env.ts` validations and
`.env` / `.env.example` defaults through the codemods, declares the keys in
`.env.schema` for varlock users, and documents the workflow in `AGENTS.md`.
`up` / `sail:sync-env` write the worktree's resolved ports into `.env.local`
(plus `.env.test.local`, which is what Adonis reads under `NODE_ENV=test`) —
Adonis loads those over `.env` on its own, so there is nothing to `eval`.

Inside an AI agent every command defaults to machine-readable JSON, never
opens a prompt, and stays idempotent with meaningful exit codes.

See the [repository README](https://github.com/DavideCarvalho/adonis-agora-sail).

## License

MIT © Davi Carvalho
