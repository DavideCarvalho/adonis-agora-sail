---
"@adonis-agora/sail": minor
---

Object storage is now one slot with four S3-compatible backends: **RustFS** (the default for new installs), **SeaweedFS**, **Garage** and **MinIO**. MinIO stopped publishing community images in October 2025 and archived its repository in April 2026 — `minio/minio` can no longer be pulled — so new MinIO blocks use Chainguard's free rebuild (`cgr.dev/chainguard/minio`), and install notes an existing `minio/minio` image with the two ways out.

Pick a backend with `node ace sail:install --object-storage=<backend>`; the choice is saved to `package.json` as `sail.objectStorage`. All four serve the same `local` bucket, region `us-east-1` and app env, and `sail:info` shows each one's ports and dashboard (RustFS console, SeaweedFS filer browser, MinIO console; Garage has none). The bucket now exists once `sail:up` returns: SeaweedFS and Garage (single-node mode, which also lays out the cluster and imports the key) create it at boot, and for RustFS and MinIO `sail:up` runs one idempotent step inside the container after the healthchecks pass. A compose file that already runs a backend keeps it; asking for another one explains how to switch instead of running two. The install note now asks for `forcePathStyle: true` next to the endpoint, and only for what the s3 disk is missing.

The exported `AGENTS_MD_START` is now the marker's prefix (`<!-- sail:start`), since the marker carries a checksum.
