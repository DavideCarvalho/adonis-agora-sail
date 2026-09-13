---
'@adonis-agora/sail': patch
---

`sail:info --json` now prints the shifted host ports under a `ports` object keyed by service name, instead of the flat `mysqlPort`/`redisPort` fields. Agents reading the JSON must index by service.
