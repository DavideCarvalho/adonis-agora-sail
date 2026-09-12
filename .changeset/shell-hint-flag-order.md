---
'@adonis-agora/sail': patch
---

The service shells' non-interactive hint puts ace flags before the `--` separator. It used to suggest `node ace sail:psql -- -c 'select 1' --json`, which hands `--json` to `psql` instead of ace — copy-pasting the hint could only fail. It now reads `node ace sail:psql --json -- -c 'select 1'`.
