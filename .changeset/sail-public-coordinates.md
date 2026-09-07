---
'@adonis-agora/sail': patch
---

Mark sail-managed connection coordinates (hosts, ports, buckets, regions, endpoints) `@public` in the generated `.env.schema` section. They are loopback dev addresses, not secrets — without this, varlock's log redaction turns every `127.0.0.1` in terminal output into `lo▒▒▒▒▒`. Credentials stay sensitive by default.
