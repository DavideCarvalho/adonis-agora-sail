---
'@adonis-agora/sail': patch
---

`sail:up` and `sail:sync-env` report a skipped encrypted `.env.local` with the same sentence, pointing at `node ace sail:info --env` and your secret manager. The two commands still differ in severity on purpose — `sync-env` fails (its one job could not be done) while `up` warns and succeeds (the stack came up) — but the wording no longer drifts between them.
