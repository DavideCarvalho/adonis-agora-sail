---
"@adonis-agora/sail": patch
---

`sail:install` no longer resets a hand-edited `AGENTS.md` section. The start marker now carries a checksum of the text sail wrote (`<!-- sail:start checksum=… -->`): while the section still matches it, install refreshes it to the current wording; once someone translated or reworded it, install leaves the file byte for byte and reports `kept`. Sections written by 0.4 (no checksum) are refreshed only while they hold the stock text. Delete the section to get the stock text back.
