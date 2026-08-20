# Public-product judge

The judge runs the built `@sjunepark/ytm` CLI and `./toolset` surfaces in
isolated Node processes. It does not import the Rust core, binding internals,
request builders, or parsers.

The fixture preload drives the compile-time-only Rust judge transport and
records prepared request metadata. Production builds cannot enable that
transport, and native clean-consumer tests exercise release builds separately.

```sh
bun run build:judge
node judge/run.mjs --product-root packages/node
bun run judge:broken
```

`judge:broken` copies the built package, corrupts the public source envelope,
and proves that the approved golden result rejects the mutation.

[`golden-results.json`](golden-results.json) is the reviewed public-conformance
oracle. After an intentional public-contract change, regenerate it only with a
complete run:

```sh
node judge/run.mjs --update-golden
```

Review every changed golden result before committing the updated oracle.
