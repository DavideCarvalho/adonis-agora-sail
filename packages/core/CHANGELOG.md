# @adonis-agora/sail

## 0.3.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/adonis-agora-sail/pull/10) [`3005508`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/300550828f14e78089115370e3c669f24fe49faf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `sail:domain` command: serve the app on `<project>.localhost` / `<project>.test` instead of a worktree-shifted port. Opt-in per app and per machine — until `sail:domain --enable` runs, no proxy exists and every other command behaves exactly as before.
  
  Enabling registers the app with a shared Traefik proxy (one per machine, since ports 80 and 443 only fit once) that routes the hostname, and any subdomain of it, to the host port this worktree's `serve` listens on. Subdomains are covered on purpose: tenant-per-subdomain apps are the case bare ports hurt most. `sail:up` re-points the route when the port moves, so a renamed worktree or a changed `PORT` keeps working without intervention.
  
  How the proxy reaches back to the host is platform-specific and generated accordingly: on Linux it shares the host network, because from the bridge the app sits behind the host's `INPUT` chain and any machine with ufw enabled drops that traffic into a 504; on macOS and Windows it publishes 80/443 off the bridge and targets `host.docker.internal`, which is what works there. `--enable` also looks the hostnames up through the system resolver and warns when they do not answer — `*.localhost` is resolved internally by browsers but not necessarily by curl, Node or a database GUI.
  
  HTTPS is issued with mkcert when the binary is present, covering the hostnames and their wildcards; without it the proxy serves plain HTTP and says so. Sail never runs `mkcert -install` and never installs a DNS resolver — both need root, so `sail:domain --install` prints the platform's instructions instead. `SAIL_DOMAIN` in `.env` pins the hostname when a team wants to agree on one.

### Patch Changes

- [#10](https://github.com/DavideCarvalho/adonis-agora-sail/pull/10) [`3005508`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/300550828f14e78089115370e3c669f24fe49faf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `sail:install` reports the env wiring it actually performed. The AdonisJS codemods catch their own failures — a missing `@adonisjs/assembler`, no `tsconfig.json` in the app root, a `start/env.ts` without `Env.create`, a `.env` that does not exist yet — and report them through the logger rather than throwing, so "it did not throw" was never evidence of a write. Install now reads the files back and, when nothing changed, says so and prints the snippet to paste instead of claiming `start/env.ts validations added (…)` for a file it never touched. The degradation branch that message lives in was unreachable until now.
  
  Under `--json` the codemods are muted through their own `useLogger()` hook, so stdout stays the single parseable document the flag promises — their progress lines used to sit next to the report and break every consumer that pipes it into a parser.

- [#10](https://github.com/DavideCarvalho/adonis-agora-sail/pull/10) [`3005508`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/300550828f14e78089115370e3c669f24fe49faf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two exits now keep the one-JSON-document-per-command contract they were breaking. Declining `sail:down --volumes`'s confirmation printed a plain log line even under `--json`, which is the one output a consumer cannot parse; it reports `{ "status": "aborted", "message": … }` now. And `sail:sync-env --json` reported `"status": "synced"` while skipping an encrypted file and exiting `1` — the payload contradicted the exit code for the one consumer that reads both. It reports `"skipped"` in that case.
  
  Both were found by the new command-level test suite, which is the first thing in this package to exercise the commands rather than the modules under them.

- [#10](https://github.com/DavideCarvalho/adonis-agora-sail/pull/10) [`3005508`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/300550828f14e78089115370e3c669f24fe49faf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Three scan corrections, all found by running the detector against real AdonisJS applications rather than hand-written snippets.
  
  `APP_NAME` no longer produces a note. Every stock `config/logger.ts` reads it and no starter kit declares it in `start/env.ts`, so sail was telling every user, on their very first install, to go fix a file that was already correct.
  
  A store selected through the environment (`default: env.get('LOCK_STORE')`, the shape `config/lock.ts`, `config/limiter.ts` and `config/session.ts` ship with) is reported as unresolvable instead of unselected. The value lives in `.env`, so no amount of reading the file settles it — and "select it and re-run install" is advice for something the user has probably already done.
  
  `drivers.redis(...)` counts as redis evidence, alongside `transports.redis(...)` and `admissions.redis(...)`. It is how `@adonisjs/queue` and bentocache name the same thing, and an app using either without `@adonisjs/redis` in its dependencies was missed entirely.

## 0.2.3

### Patch Changes

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `sail:up` and `sail:sync-env` report a skipped encrypted `.env.local` with the same sentence, pointing at `node ace sail:info --env` and your secret manager. The two commands still differ in severity on purpose — `sync-env` fails (its one job could not be done) while `up` warns and succeeds (the stack came up) — but the wording no longer drifts between them.

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Commands now exit with the code of whatever actually failed. `failJsonAware` used to assign `1` after the caller had already stored the child's status, so a failing `docker compose up`, `sail:logs`, `sail:down` or one-shot `sail:psql` collapsed to `1` while the message still quoted the real code (`sail:psql failed (exit 3)`). A failing query now fails the surrounding script with the status the query produced; sail's own refusals (missing compose file, unusable docker, flag conflicts) still exit `1`.

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `sail:up` probes the stack's host ports before touching docker and fails loud naming the holder (`:5621 (held by shop-main-postgres-1)`) when another stack already owns one — instead of starting cross-wired onto the wrong database. Ports the stack itself publishes are subtracted, so re-running `up` on a live stack stays a silent success, and the probe is scoped to the services the compose file declares: a postgres-only stack is never blocked by someone else's MySQL on 3306.

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `sail:share --json` prints exactly one JSON document. The base-port fallback notice and the "nothing is listening" warning used to be printed as their own objects before the result, so stdout was a sequence a consumer had to read until it saw a `url`; they now ride along as `notice` / `warning` on the result object. The URL scanner also detaches from the child's streams once the tunnel URL is known — it kept appending every line cloudflared logged to an in-memory buffer for the life of the tunnel.

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The service shells' non-interactive hint puts ace flags before the `--` separator. It used to suggest `node ace sail:psql -- -c 'select 1' --json`, which hands `--json` to `psql` instead of ace — copy-pasting the hint could only fail. It now reads `node ace sail:psql --json -- -c 'select 1'`.

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `sail:sync-env` exits `1` for a skipped encrypted `.env.local` in JSON mode too. The exit code was assigned while printing the human warnings, after the `--json` path had already returned, so the same condition failed for a human and succeeded for an agent — which is exactly the consumer that cannot see the warning.

- [#4](https://github.com/DavideCarvalho/adonis-agora-sail/pull/4) [`bb82760`](https://github.com/DavideCarvalho/adonis-agora-sail/commit/bb82760133c5797d50db0e438af443228cdb9995) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare the Adonis env access idioms in the `.env.schema` sail manages, so `varlock audit` stops reporting every key as unreferenced. The audit's built-in patterns only see bare `process.env.X`-style identifiers, which an Adonis app never writes — config and app code go through `env.get('DB_HOST')`, and the keys the framework itself reads (`HOST`, `PORT`, `LOG_LEVEL`) only ever appear as `KEY: Env.schema.…()` declarations in `start/env.ts`. Sail now emits two `@auditExtraPatterns()` root decorators covering both, one call per idiom so each keeps its own explanatory comment.
  
  They are root decorators, so they only mean anything above the `# ---` divider: a schema created from scratch gets a real root section (header, the two lines, divider, then the managed item block), and an existing schema that has a divider gets them inserted right above it. A schema that already declares `@auditExtraPatterns` anywhere — sail's line or a hand-written one for your own config wrapper — is left completely alone, since calls merge additively and a second copy would just double the scan. A schema with no divider at all is reported, not rewritten: inserting one would silently reinterpret the file's leading comments as root decorators, so install prints the lines and where they go, like it already does for `MAIL_MAILER` and `DRIVE_DISK`.

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
