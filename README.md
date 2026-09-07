# `@adonis-agora/sail`

> Docker-powered local dev services for **AdonisJS** — worktree-native,
> agent-friendly. Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

| Package | What |
|---|---|
| [`@adonis-agora/sail`](./packages/core) | `sail:*` ace commands: auto-detected `compose.yml`, per-worktree isolated stacks with deterministic ports, service shells, tunnels, JSON output for agents |

```bash
node ace add @adonis-agora/sail
node ace sail:install   # scan package.json + env.ts + configs, write compose.yml, wire env
node ace sail:up        # start + wait for healthchecks, sync ports into .env.local
node ace sail:psql      # psql REPL (or -- -c 'select 1')
node ace sail:share     # public tunnel URL for previews and webhooks
```

Sail containerizes **services, not the app**: Postgres, MySQL, Redis, Mailpit
and MinIO run in Docker while the app stays on the host with `node ace serve
--hmr` — fast HMR and debugger included. Every git worktree gets **isolated
containers and shifted host ports automatically** (`myapp-feature-login`,
`5432 + hash(name) % 1000`), so five worktrees never fight over a database.
`install` reads `start/env.ts` + `config/*.ts` (including active `store:
'lucid'` selections in Agora configs), adds the missing `Env.schema`
validations and `.env` defaults via the codemods, and every command speaks
JSON inside AI agents (`--json` default, never prompts, idempotent, meaningful
exit codes).

See the [documentation](./docs) for the full surface.

## License

MIT © Davi Carvalho
