# `@adonis-agora/sail`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail) [![CI](https://github.com/DavideCarvalho/adonis-agora-sail/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-sail/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail)

> Docker-powered local dev services for **AdonisJS** — worktree-native,
> agent-friendly. Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

| Package | What |
|---|---|
| [`@adonis-agora/sail`](./packages/core) [![npm](https://img.shields.io/npm/v/@adonis-agora/sail)](https://www.npmjs.com/package/@adonis-agora/sail) | `sail:*` ace commands: auto-detected `compose.yml`, per-worktree isolated stacks with deterministic ports, service shells, tunnels, JSON output for agents |

```bash
node ace add @adonis-agora/sail
node ace sail:install   # scan package.json + env.ts + configs, write compose.yml, wire env
node ace sail:up        # start + wait for healthchecks, sync ports into .env.local
node ace sail:psql      # psql REPL (or -- -c 'select 1')
node ace sail:serve     # app in the background, shared per worktree (--stop, --restart)
node ace sail:share     # public tunnel URL for previews and webhooks
```

Sail containerizes **services, not the app**: Postgres, MySQL, Redis, Mailpit
and S3-compatible object storage run in Docker while the app stays on the host with `node ace serve
--hmr` — fast HMR and debugger included. Every git worktree gets **isolated
containers and shifted host ports automatically** (`myapp-feature-login`,
`5432 + hash(name) % 1000`), so five worktrees never fight over a database.
`install` reads `start/env.ts` + `config/*.ts` (including active `store:
'lucid'` selections in Agora configs), adds the missing `Env.schema`
validations and `.env` defaults via the codemods, and every command speaks
JSON inside AI agents (`--json` default, never prompts, idempotent, meaningful
exit codes).

See the [documentation](./docs) for the full surface.

## Object storage backends

MinIO's company has walked away from the open-source edition: it stopped
publishing community images in October 2025 and archived the repository in
April 2026, and `minio/minio` can no longer be pulled from Docker Hub. Sail
therefore offers four S3-compatible backends for the same slot — they serve the
same `local` bucket, the same region and the same app env, so `config/drive.ts`
works unchanged with any of them:

```bash
node ace sail:install --object-storage=seaweedfs   # or rustfs, garage, minio
```

The choice is saved to `package.json` (`"sail": { "objectStorage": "seaweedfs" }`),
so the next plain `node ace sail:install` — yours or a teammate's — keeps it.

| | **RustFS** (default) | SeaweedFS | Garage | MinIO |
| --- | --- | --- | --- | --- |
| Licence | Apache-2.0 | Apache-2.0 | AGPL-3.0 | AGPL-3.0, repository archived |
| Maintenance | very active, 1.0 in Sep 2026 | very active, releases every few weeks | active, v2.4 in Sep 2026 | none upstream; Chainguard rebuilds the image |
| Image | `rustfs/rustfs:1.0.3` (~420 MB) | `chrislusf/seaweedfs:4.48` (~720 MB) | `dxflrs/garage:v2.4.1` (~100 MB) | `cgr.dev/chainguard/minio` (~235 MB) |
| Idle RAM (measured) | ~30 MB | ~95 MB | ~5 MB | ~60 MB |
| Web UI | MinIO-style console | filer file browser | none | console |
| Bucket bootstrap | `sail:up` (one signed `PUT`) | built in (`S3_BUCKET`) | built in (`--single-node --default-bucket`) | `sail:up` (`mc mb`) |
| Needs | — | — | Compose ≥ 2.23.1 (inline config) | — |

**Why RustFS is the default.** It is the smallest step for anyone coming from
MinIO: the same port layout (S3 on 9000, console on 9001), a web console to see
what your app uploaded, and the same `sail` / `password` credentials as every
other sail service. It is permissively licensed (Apache-2.0, no AGPL question
to answer, even for a dev container), actively maintained, and idles at around
30 MB of RAM. The one thing it cannot do from its own environment — create the
bucket — `sail:up` does for it with one idempotent signed request.

**When to pick another one.** **SeaweedFS** if you want a bare
`docker compose up` (no sail) to come up with the bucket already there — its
`weed mini` mode creates it from an env var — and do not mind the larger
image. **Garage** if footprint matters most (5 MB of RAM, a 100 MB image) and
you can live without a web UI; it is AGPL-3.0, which only matters if you
redistribute it. **MinIO** stays for stacks that already run it.

Every backend was exercised end to end with sail itself — `sail:install`,
`sail:up`, then put/get/list/signed-URL/delete through the AdonisJS drive s3
driver (flydrive) with the env sail wrote — before it shipped.

## Sponsors

Every Agora library is MIT and stays free. The work is funded by partners and
sponsors — [become one](https://davidecarvalho.github.io/agora/partners).

## License

MIT © Davi Carvalho
