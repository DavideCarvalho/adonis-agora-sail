---
"@adonis-agora/sail": minor
---

The Postgres image is configurable (`"sail": { "images": { "postgres": "postgres:16" } }` in `package.json`), and pgvector is detected: when a migration under `database/migrations/` creates the `vector` extension, a new `postgres` block runs `pgvector/pgvector:pg17` — the same major as `postgres:17` — or the pgvector build of the configured major. Existing blocks are never rewritten; install notes the image to switch to instead.
