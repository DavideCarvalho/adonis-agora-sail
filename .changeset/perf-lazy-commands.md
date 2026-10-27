---
"@adonis-agora/sail": patch
---

perf: load sail commands lazily. The ace kernel reads every command loader's metadata on each `node ace` invocation (`serve`, `migration:run`, …), and the commands barrel used to import all fifteen commands and their dependencies (`yaml`, the app scanner) to answer it. It now answers from a `commands.json` index generated at build time and imports a command only when it runs (about 32 ms → 2 ms per `node ace` call), falling back to the eager list when no index is present. Also: `sail:up` and the service shells (`sail:psql`/`sail:mysql`/`sail:redis`) reuse their resolved context instead of running `git worktree list` a second time, `sail:info` and `sail:sync-env` read the varlock setup alongside the stack info, and `sail:prune` lists projects and volumes concurrently and stops independent orphan stacks in parallel.
