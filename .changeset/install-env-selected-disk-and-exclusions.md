---
"@adonis-agora/sail": minor
---

`sail:install` no longer provisions object storage for an s3 disk picked through the environment. The stock `config/drive.ts` reads `default: env.get('DRIVE_DISK')`, usually `fs` in development, so — like a session or lock store chosen through env — sail now says it cannot tell and points at `--object-storage`, instead of starting a container nobody uses. A `DRIVE_DISK` enum that only admits `s3` still counts.

Preferences now persist under a `sail` key in `package.json`: `objectStorage`, `exclude` (service names, or `object-storage` for the whole slot) and `images`. `--exclude=<service>` records an exclusion, so a service you removed from `compose.yml` does not come back on the next plain install; `--services` still wins over it.
