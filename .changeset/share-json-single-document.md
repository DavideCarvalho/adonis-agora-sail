---
'@adonis-agora/sail': patch
---

`sail:share --json` prints exactly one JSON document. The base-port fallback notice and the "nothing is listening" warning used to be printed as their own objects before the result, so stdout was a sequence a consumer had to read until it saw a `url`; they now ride along as `notice` / `warning` on the result object. The URL scanner also detaches from the child's streams once the tunnel URL is known — it kept appending every line cloudflared logged to an in-memory buffer for the life of the tunnel.
