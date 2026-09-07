---
'@adonis-agora/sail': minor
---

App-aware detection and env wiring. `sail:install` now scans `start/env.ts` + `config/*.ts` on top of `package.json`: first-party configs pin their service, active `store: 'lucid'` selections in `@adonis-agora/*` configs count as database evidence, commented-out alternatives are ignored, and a dependency contradicted by its config is skipped with a note. Install also adds missing `start/env.ts` validations and `.env`/`.env.example` defaults via the codemods (append-only, existing values never overwritten). `sail:up`/`sail:sync-env` sync worktree ports into `.env.local` + `.env.test.local` for every app (Adonis loads them over `.env`), and MinIO now emits the stock `AWS_*`/`S3_BUCKET`/`S3_ENDPOINT` keys `config/drive.ts` actually reads.
