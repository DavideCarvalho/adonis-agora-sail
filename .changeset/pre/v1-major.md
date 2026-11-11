---
"@adonis-agora/sail": major
---

1.0. Breaking changes, all covered with before/after snippets in the "Migrating to 1.0" docs page:

- **Node.js 24 or newer.** `engines.node` is now `>=24`, the floor `@adonisjs/core` 7 declares (was `>=22`).
- **`MINIO_SETUP_NOTE` is removed.** Import `OBJECT_STORAGE_SETUP_NOTE` instead: same string, and it applies to every object storage backend, not only MinIO.
- **`AGENTS.md` sections without a checksum are no longer refreshed.** `sail:install` keeps a section whose start marker is a bare `<!-- sail:start -->` (written by sail 0.4 and earlier) as if it were edited by hand. Run `sail:install` once on the latest 0.x before upgrading, or delete the old section and re-run install on 1.0.
