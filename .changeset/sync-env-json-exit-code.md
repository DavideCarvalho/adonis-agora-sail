---
'@adonis-agora/sail': patch
---

`sail:sync-env` exits `1` for a skipped encrypted `.env.local` in JSON mode too. The exit code was assigned while printing the human warnings, after the `--json` path had already returned, so the same condition failed for a human and succeeded for an agent — which is exactly the consumer that cannot see the warning.
