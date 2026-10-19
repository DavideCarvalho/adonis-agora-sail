---
"@adonis-agora/sail": patch
---

Two env fixes. `sail:install` leaves `.env` and `.env.example` ending with a newline (the codemods' editor wrote none, so the next `echo KEY=value >> .env` glued onto the last key). And the env sail syncs into `.env.local` now blanks `REDIS_PASSWORD`: sail's Redis has no auth, and a production password in `.env` was still being sent to it. The key is left out when `start/env.ts` declares it required, where an empty value would fail boot.
