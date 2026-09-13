---
'@adonis-agora/sail': patch
---

Three scan corrections, all found by running the detector against real AdonisJS applications rather than hand-written snippets.

`APP_NAME` no longer produces a note. Every stock `config/logger.ts` reads it and no starter kit declares it in `start/env.ts`, so sail was telling every user, on their very first install, to go fix a file that was already correct.

A store selected through the environment (`default: env.get('LOCK_STORE')`, the shape `config/lock.ts`, `config/limiter.ts` and `config/session.ts` ship with) is reported as unresolvable instead of unselected. The value lives in `.env`, so no amount of reading the file settles it — and "select it and re-run install" is advice for something the user has probably already done.

`drivers.redis(...)` counts as redis evidence, alongside `transports.redis(...)` and `admissions.redis(...)`. It is how `@adonisjs/queue` and bentocache name the same thing, and an app using either without `@adonisjs/redis` in its dependencies was missed entirely.
