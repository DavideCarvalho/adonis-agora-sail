# `@adonis-agora/sail`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail) [![CI](https://github.com/DavideCarvalho/adonis-agora-sail/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-sail/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail)

Docker-powered local dev services for AdonisJS. Sail runs Postgres, MySQL,
Redis, Mailpit and S3-compatible object storage (RustFS by default; SeaweedFS,
Garage or MinIO on request) in Docker while the app itself stays on the host —
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
node ace sail:prune --dry-run   # stacks and volumes left behind by deleted worktrees
```

### How it works

`install` detects services from `package.json` **and** `config/*.ts`
(`client: 'pg'`, `config/redis.ts`, smtp mailers, s3 disks, active
`store: 'lucid'` selections in Agora configs — commented-out alternatives
are ignored, and a dependency contradicted by its config is skipped with a
note; an s3 disk picked through `DRIVE_DISK` is left to `--object-storage`).
Preferences that should stick — the object storage backend, services to
leave out, image overrides — live under `sail` in `package.json`. It writes
a worktree-agnostic `compose.yml` (host ports interpolate
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
