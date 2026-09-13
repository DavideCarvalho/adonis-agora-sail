---
'@adonis-agora/sail': patch
---

`sail:share --json` now prints exactly one JSON document. The base-port fallback notice and the "nothing is listening" warning were previously emitted as separate objects ahead of the result, forcing a consumer to read stdout until it saw an object carrying a `url`; they now ride along as `notice` / `warning` on the single result object.
