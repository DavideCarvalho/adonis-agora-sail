# @adonis-agora/sail

## 0.2.2

### Patch Changes

- [`e389934`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/e389934f67fcdcc8046c7e85fb6bd5c719bdf490) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correct the `DockerCompose.logs()` doc comment: it only streams to the terminal when `follow` is set, otherwise the output is returned in the `RunResult`.

## 0.2.1

### Patch Changes

- [`36d041b`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/36d041b1d7125e1c207cfd7af6fca07485c16a2c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correct the `buildSailEnvBlock` doc comment: the `.env.local` block it builds does carry the services' fixed dev credentials, which is why the file is git-ignored.

- [`6ed1fb4`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/6ed1fb4f4dc65590f66918c90b44b23c6622bb12) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Mark sail-managed connection coordinates (hosts, ports, buckets, regions, endpoints) `@public` in the generated `.env.schema` section. They are loopback dev addresses, not secrets — without this, varlock's log redaction turns every `127.0.0.1` in terminal output into `lo▒▒▒▒▒`. Credentials stay sensitive by default.

## 0.2.0

### Minor Changes

- [`c1c9b2d`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/c1c9b2d5eac3210e157188ab9958d9ce91a3ac42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - App-aware detection and env wiring. `sail:install` now scans `start/env.ts` + `config/*.ts` on top of `package.json`: first-party configs pin their service, active `store: 'lucid'` selections in `@adonis-agora/*` configs count as database evidence, commented-out alternatives are ignored, and a dependency contradicted by its config is skipped with a note. Install also adds missing `start/env.ts` validations and `.env`/`.env.example` defaults via the codemods (append-only, existing values never overwritten). `sail:up`/`sail:sync-env` sync worktree ports into `.env.local` + `.env.test.local` for every app (Adonis loads them over `.env`), and MinIO now emits the stock `AWS_*`/`S3_BUCKET`/`S3_ENDPOINT` keys `config/drive.ts` actually reads.

- [`c1c9b2d`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/c1c9b2d5eac3210e157188ab9958d9ce91a3ac42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Initial release: Docker-powered local dev environment for AdonisJS. `sail:install` auto-detects services and generates a worktree-agnostic `compose.yml`, `sail:up/down/ps/logs/info/exec/prune` wrap compose with per-worktree isolated projects, deterministic shifted ports and agent-friendly JSON output.

- [`c1c9b2d`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/c1c9b2d5eac3210e157188ab9958d9ce91a3ac42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Service shells and sharing. New `sail:psql`, `sail:mysql` and `sail:redis` commands open the service client's REPL on a terminal, or run a captured one-shot with a propagated exit code when given args (`sail:psql -- -c 'select 1'`) — the agent-safe form, since a bare invocation fails without a TTY instead of hanging. New `sail:share` exposes the worktree's `serve` port on a public `*.trycloudflare.com` URL via cloudflared (no account needed) for previews and webhook integrations; the port resolves exactly like `serve` does, `--json` prints one `{ url, local }` line and keeps running until killed. When the worktree port is closed but the base `PORT` answers (a core without the worktree-port patch), it shares the base port instead and says so.

- [`c1c9b2d`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/c1c9b2d5eac3210e157188ab9958d9ce91a3ac42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Varlock integration (opt-in by detection): when the app uses varlock (`.env.schema` or the `varlock` dependency), `sail:install` declares the services' connection keys in the schema (append-only, `@tag(sail)`, main-checkout defaults), while `sail:up` and the new `sail:sync-env` sync per-worktree ports into the sail-managed block of `.env.local` — so `varlock run -- node ace serve --hmr` picks up the right ports in every worktree. Non-varlock apps are untouched.

### Patch Changes

- [`c1c9b2d`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/c1c9b2d5eac3210e157188ab9958d9ce91a3ac42) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fixes found by live-testing against two real apps. `ace configure @adonis-agora/sail` failed with "does not export the configure hook" because ace imports the package root — `configure` is now re-exported from the main entrypoint (runtime-framework-free, the hook file only imports `type Configure`). `sail:ps` no longer lists each published port twice on compose v5 (IPv4 + IPv6 entries are deduped).
