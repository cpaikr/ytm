# `@sjunepark/ytm` Rust candidate

This review package contains the Node-only ytm product backed by the Rust core.
Its CLI and `./toolset` surface match the published package except for the
approved Node 22 floor, removal of custom JavaScript transport injection, and
addition of canonical kind `80` (`회사채(사모)`).

The final cutover moves this product to `packages/node`. See the repository
[`SPEC.md`](../../SPEC.md) and [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
