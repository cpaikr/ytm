# `@sjunepark/ytm`

Deterministic KIS-NET YTM Matrix CLI and runtime-neutral toolset, backed by a
Rust HTTP and Nexacro core.

Node.js 22 or newer is required. Supported native targets are Linux GNU
x64/ARM64, macOS ARM64, and Windows x64. After installing an authorized
artifact, use the package-provided CLI:

```sh
ytm matrix --base-date 2026-06-08 --kind 국채 --format json
ytm kinds --format json
```

This rewrite has not been published yet. For the current checkout, follow the
root README instead of installing the historical npm `latest` release.

Run `ytm --help` and `ytm <command> --help` before automation to inspect the
current inputs, examples, output contract, and recovery guidance.

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
