---
'@adonis-agora/sail': minor
---

Varlock integration (opt-in by detection): when the app uses varlock (`.env.schema` or the `varlock` dependency), `sail:install` declares the services' connection keys in the schema (append-only, `@tag(sail)`, main-checkout defaults), while `sail:up` and the new `sail:sync-env` sync per-worktree ports into the sail-managed block of `.env.local` — so `varlock run -- node ace serve --hmr` picks up the right ports in every worktree. Non-varlock apps are untouched.
