---
"@adonis-agora/sail": major
---

1.0. Breaking changes, all covered with before/after snippets in the "Migrating to 1.0" docs page:

- **Node.js 24 or newer.** `engines.node` is now `>=24`, the floor `@adonisjs/core` 7 declares (was `>=22`).
- **`MINIO_SETUP_NOTE` is removed.** Import `OBJECT_STORAGE_SETUP_NOTE` instead: same string, and it applies to every object storage backend, not only MinIO.
