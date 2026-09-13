---
'@adonis-agora/sail': patch
---

Two exits now keep the one-JSON-document-per-command contract they were breaking. Declining `sail:down --volumes`'s confirmation printed a plain log line even under `--json`, which is the one output a consumer cannot parse; it reports `{ "status": "aborted", "message": … }` now. And `sail:sync-env --json` reported `"status": "synced"` while skipping an encrypted file and exiting `1` — the payload contradicted the exit code for the one consumer that reads both. It reports `"skipped"` in that case.

Both were found by the new command-level test suite, which is the first thing in this package to exercise the commands rather than the modules under them.
