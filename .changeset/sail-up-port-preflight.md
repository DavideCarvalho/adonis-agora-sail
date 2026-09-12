---
'@adonis-agora/sail': patch
---

`sail:up` probes the stack's host ports before touching docker and fails loud naming the holder (`:5621 (held by shop-main-postgres-1)`) when another stack already owns one — instead of starting cross-wired onto the wrong database. Ports the stack itself publishes are subtracted, so re-running `up` on a live stack stays a silent success, and the probe is scoped to the services the compose file declares: a postgres-only stack is never blocked by someone else's MySQL on 3306.
