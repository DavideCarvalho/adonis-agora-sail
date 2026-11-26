---
"@adonis-agora/sail": patch
---

Harden env output: `sail:info --env` single-quotes a value only when it is not a plain shell word (ports, hosts and urls print unchanged), and the docs now recommend `eval "$(node ace sail:info --env)"`. The `.env.local` / `.env.test.local` / `.env.schema` writers spell each value so AdonisJS and varlock both read it back exactly (`$` escaped, quoted when a `#`, quote or edge space needs it) and refuse a value with a line break.
