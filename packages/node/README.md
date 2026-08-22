# `@sjunepark/ytm`

Rust-backed KIS-NET YTM Matrix SDK for Node.js.

This package exports the runtime-neutral toolset and platform Node-API loader.
It has no `bin` entry or JavaScript CLI; the standalone `ytm` executable is the
Rust/Clap workspace binary in `crates/ytm-cli`.

Node.js 22 or newer is required. Supported native targets are Linux GNU
x64/ARM64, macOS ARM64, and Windows x64.

This rewrite has not been published yet. For the current checkout, follow the
root README instead of installing the historical npm `latest` release.

```js
import { createKisnetYtmToolset } from "@sjunepark/ytm/toolset";

const ytm = createKisnetYtmToolset();
const result = await ytm.execute("matrix", {
  baseDate: "2026-06-08",
  kind: "국채"
});
```

The source is protocol-feasible but not production-qualified. See the
repository [`SPEC.md`](https://github.com/cpaikr/ytm/blob/main/SPEC.md),
[`ARCHITECTURE.md`](https://github.com/cpaikr/ytm/blob/main/ARCHITECTURE.md),
and provider qualification record before high-volume, retained, or
redistributed use.
