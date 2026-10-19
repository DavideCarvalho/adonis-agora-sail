---
"@adonis-agora/sail": minor
---

Support Node.js 22 again: `engines.node` is `>=22`, and CI runs the test suite on 22, 24 and 26. Sail itself uses nothing newer than Node 22 (the whole suite passes on 22.21.1), and real AdonisJS 7 apps pinned to 22 were running it fine while the `>=24` floor made package managers flag it. `@adonisjs/core` 7 still declares `>=24` for itself, so a warning on 22 is now about the framework, not about sail.
