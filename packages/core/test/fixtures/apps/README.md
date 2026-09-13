# Real application fixtures

Three AdonisJS application trees, trimmed to the files `scanAppConfig` reads
(`package.json`, `start/env.ts`, `config/*.ts`, `.env.example`) but **not**
simplified: the comment blocks, the `defineConfig({…})` wrappers, the multiple
connections, the commented-out alternatives and the `env.get(…)` calls are the
ones the source files actually ship. `test/real_apps.spec.ts` scans these and
runs `sail:install` against a copy of each.

They exist because inline template strings in `app_scan.spec.ts` can keep
passing while a real application is not detected at all — a stock
`config/mail.ts` opens with 20 lines of comment, a stock `config/database.ts`
is one nested `defineConfig` call, and a real one has three connections sharing
a hoisted `connection` object.

Prose comments in Portuguese were shortened where they were business-specific,
and long blocks of commented-out configuration were cut down — but at least one
long comment block, and at least one commented-out driver selection, is kept in
every tree, because "comments before the first line of code" and "a commented
alternative that must not read as an active selection" are exactly what breaks
naive parsers.

None of these apps is runnable: there is no `app/`, no `bin/`, no
`adonisrc.ts`, and their dependencies are never installed.

## `starter-kit/` — what a new user has

The official AdonisJS web starter kit plus the three packages a user adds
first. Sources:

- `package.json`, `start/env.ts`, `config/session.ts`, `config/logger.ts`,
  `.env.example` — `adonisjs/web-starter-kit@main`, with the `pg`,
  `@adonisjs/mail`, `@adonisjs/drive` and `@aws-sdk/*` dependencies a
  `node ace add` run would have appended.
- `config/database.ts` — `adonisjs/presets@main`,
  `src/lucid/stubs/config/database/postgres.stub`, rendered.
- `config/mail.ts` — `adonisjs/mail@develop`, `stubs/config/mail.stub`,
  rendered with `transports = ['smtp']`. The commented-out `auth` block is the
  stub's own, and it reads `SMTP_USERNAME` / `SMTP_PASSWORD` — keys the scanner
  must *not* report as used.
- `config/drive.ts` — `adonisjs/drive@develop`, `stubs/config/drive.stub`,
  rendered with `services = ['fs', 's3']`.
- The `start/env.ts` blocks below `SESSION_DRIVER` are what the lucid preset
  and the mail/drive `configure` hooks append via `defineEnvValidations`.

## `agora-stack/` — the library's actual audience

Modelled on `~/personal/streaming-educacao/apps/entre-textos`, a production app
built on the Agora packages. `config/database.ts`, `config/redis.ts`,
`config/mail.ts`, `config/drive.ts`, `config/telescope.ts`, `config/media.ts`,
`config/durable.ts`, `config/authz.ts`, `config/queue.ts`, `config/lock.ts`,
`start/env.ts` and `package.json` are trimmed copies of that app's files.

What makes it different from the starter kit, and why each part is kept:

- three pg connections over one hoisted `const connection = {…}`, so the
  `client:` the scanner finds is nowhere near the `env.get` calls;
- `"pg": "catalog:"` — pnpm catalog version ranges, not semver strings;
- `store: 'lucid'` / `default: 'lucid'` selections in four Agora configs, which
  is how those packages ask for a database;
- an s3 disk whose endpoint variable is `MINIO_URL`, not `S3_ENDPOINT`;
- `stores.redis(…)` under a `default: env.get('LOCK_STORE')` the scanner
  cannot resolve.

## `sqlite-only/` — the negative case

`~/personal/oss/adonis/agora/examples/end-to-end`, the runnable example app that
composes several Agora libraries on SQLite with zero external infrastructure.
`config/database.ts`, `config/drive.ts`, `config/media.ts`, `config/authz.ts`,
`config/session.ts`, `config/logger.ts` and `start/env.ts` are verbatim copies;
`config/telescope.ts` is that file with most of its commented-out option blocks
removed (the commented `lucid: storage.lucid({ connection: 'pg' })` line is
deliberately kept).

It must provision nothing. It mentions `lucid`, `database`, `s3`, `drive` and
`store` all over the place — `config/authz.ts` even selects the lucid store —
yet the configured client is `better-sqlite3` and the only disk is `fs`.

## No `.env`

The trees ship `.env.example` only: this repository's `.gitignore` excludes
`.env`, so a committed one would not survive. It is also the honest starting
point — a fresh clone of an app has the example and not the real file. The
spec's `materializeApp` does the `cp .env.example .env` every AdonisJS setup
starts with, and one test deliberately skips it: AdonisJS' `EnvEditor` only
updates dotenv files that already exist, so an app with no `.env` gets sail's
defaults in `.env.example` and nothing else.

## No `tsconfig.json` either

The AdonisJS codemods refuse to touch `start/env.ts` without a tsconfig at the
app root, and a real app's `extends: "@adonisjs/tsconfig/tsconfig.app.json"`
cannot resolve inside a temp directory with no `node_modules`. So the spec
writes a self-contained one into the copy rather than committing a fake one
here — detection never reads it, only ts-morph does.
