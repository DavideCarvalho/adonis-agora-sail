---
name: sail-basics
description: >
  Run an AdonisJS app's local services with @adonis-agora/sail: node ace
  sail:install to generate compose.yml, sail:up/down, per-worktree isolated
  containers with deterministic shifted ports, sail:info for the actual ports
  and connection env, and JSON output for agents. Use when starting local
  dev services, debugging DB/Redis/mail connections, or operating the stack
  from a coding agent.
metadata:
  type: core
  library: "@adonis-agora/sail"
  library_version: "0.1.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-agora-sail:docs/getting-started.mdx"
---

# Sail basics: services up, ports per worktree

Sail runs backing services (Postgres, Redis, Mailpit, MinIO) in Docker while
the app itself runs on the host with `node ace serve --hmr`. Every git
worktree gets **isolated containers and shifted host ports** automatically —
never hardcode `5432` outside the main checkout.

## Setup

```bash
node ace sail:install   # scan package.json + env.ts + configs, write compose.yml + wire env
node ace sail:up        # start + wait for healthchecks, sync ports, then print ports/env
```

`node ace sail:up && node ace migration:run` works with no sleeps: `up`
waits for healthchecks before returning, and re-running it is a silent
success.

## The one rule: ask sail for ports

Host ports are `base + worktree offset` (deterministic per worktree name, so
teammates on the same worktree name get the same ports). Query, don't guess:

```bash
node ace sail:info              # human summary: ports, dashboards, app env
node ace sail:info --json       # full stack object (default inside agents)
eval $(node ace sail:info --env)  # export DB_/REDIS_/SMTP_/AWS_ vars (fallback)
```

No `eval` needed in the normal flow: `sail:up` / `sail:sync-env` write
the worktree's ports into `.env.local` (plus `.env.test.local`, which is
what Adonis reads under `NODE_ENV=test`), and Adonis loads those files
over `.env` on its own. Just boot the app.

## What install scans (and wires for you)

`--services=` flags win; otherwise sail reads, in order:

1. `package.json` deps (`pg` → postgres, `@adonisjs/redis` → redis, …);
2. `config/database.ts` (`client: 'pg'`), `config/redis.ts`,
   `config/mail.ts` (smtp mailer), `config/drive.ts` (s3 disk);
3. other `config/*.ts` — active `store: 'lucid'` / `default: 'lucid'`
   selections in `@adonis-agora/*` configs (telescope, media, authz…)
   count as evidence for the configured database. Commented-out
   alternatives are ignored, and a dep contradicted by its config
   (e.g. `@adonisjs/drive` installed but drive uses fs-only) is skipped
   with a note instead of provisioning an idle container.

Then it wires, all append-only: missing `start/env.ts` validations via
the codemods (stock first-party shapes; `MAIL_MAILER`/`DRIVE_DISK` are
reported, never guessed), main-checkout defaults into `.env` /
`.env.example` for keys missing from both, and the varlock schema when
detected. Existing declarations and values are never overwritten.
`node ace sail:info` shows the evidence per service plus any notes
(sqlite, memory stores, the MinIO `S3_ENDPOINT` passthrough).

## Everyday commands

```bash
node ace sail:ps                # container state, health, published ports
node ace sail:logs --tail 100              # captured text (or --json)
node ace sail:logs redis --since 10m       # one service, recent logs
node ace sail:exec redis -- redis-cli ping # one-shot command, exit code propagates
node ace sail:psql                         # psql REPL (or -- -c 'select 1')
node ace sail:mysql -- -e 'show tables'    # one-shot, exit code propagates
node ace sail:redis -- ping                # redis-cli REPL (or one-shot)
node ace sail:share                        # public tunnel URL for the app
node ace sail:down               # stop this worktree's stack
node ace sail:prune --dry-run    # stacks left behind by deleted worktrees
```

`--follow` streams text and refuses `--json`. `sail:prune` without
`--dry-run` stops orphans (compose file gone from disk); other apps'
projects are never touched.

## Service shells and sharing

- `sail:psql` / `sail:mysql` / `sail:redis` open the client's REPL on a
  terminal; with args (`-- -c 'select 1'`) they run a captured one-shot
  with a propagated exit code — the form agents must use, since a bare
  invocation refuses `--json` and fails without a TTY instead of hanging.
  They connect over the container network, so worktree port offsets never
  matter, and they refuse to run for services `sail:install` did not enable.
- `sail:share` exposes the worktree's `serve` port on a public
  `*.trycloudflare.com` URL (no account; needs the `cloudflared` binary).
  The port resolves exactly like `serve` does (dot-env `PORT` in loader
  priority + worktree offset; `--port` overrides) — and if that port is
  closed but the base `PORT` answers (a core without the worktree-port
  patch serves plain `PORT` even in a worktree), it shares the base port
  instead and says so. Use it for previews and webhook integrations
  (payments providers calling back into your machine). It stays attached
  until interrupted; with `--json` it prints one `{ url, local }` line on
  stdout, keeps tunnel logs on stderr, and keeps running — kill the command
  to stop sharing. No docker involved.

## Varlock users

Sail auto-detects varlock (`.env.schema` or the `varlock` dependency).
`install` additionally declares the service keys in `.env.schema`
(append-only, your types win); the port sync targets the same
`.env.local` every app uses, so `varlock run --` keeps working unchanged:

```bash
node ace sail:sync-env  # re-sync ports without touching containers
varlock run -- node ace serve --hmr        # boot with resolved + validated env
varlock run -- node ace migration:run      # same for migrations
```

Rules: `.env.schema` holds shape + main-checkout defaults; `.env.local`
holds the live per-worktree ports inside `# sail:start`/`# sail:end` —
everything else in the file is preserved. Encrypted `.env.local` is
detected and skipped with a warning instead of corrupted. Agents read
`.env.schema` for context (no secrets) plus `sail:info --json` for live
ports.

## Agent notes

- Inside an AI agent every command defaults to JSON, never prompts, and
  never uses ANSI/spinners. If `sail:install` cannot detect services it
  fails with the exact `--services=` flags to re-run.
- `sail:install` keeps an `AGENTS.md` section (`<!-- sail:start -->`)
  describing this workflow — that is how future agents discover it.
- `compose.yml` interpolates `${SAIL_*_PORT:-base}`: the committed file is
  identical in every worktree, sail injects offset ports at runtime, and a
  bare `docker compose up` still works with defaults.
```

## Core patterns

### 1. Install → up → migrate

```bash
node ace sail:install
node ace sail:up && node ace migration:run
```

### 2. Debug a connection failure

```bash
node ace sail:ps --json
node ace sail:info --json   # compare the app's env against these ports
node ace sail:logs --tail 100
```
