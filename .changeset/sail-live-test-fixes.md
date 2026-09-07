---
'@adonis-agora/sail': patch
---

Fixes found by live-testing against two real apps. `ace configure @adonis-agora/sail` failed with "does not export the configure hook" because ace imports the package root — `configure` is now re-exported from the main entrypoint (runtime-framework-free, the hook file only imports `type Configure`). `sail:ps` no longer lists each published port twice on compose v5 (IPv4 + IPv6 entries are deduped).
