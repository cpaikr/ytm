# Public-product judge

The judge runs the standalone Rust `ytm` binary and the built
`@sjunepark/ytm/toolset` surface in isolated processes. It does not import the
Rust core, binding internals, request builders, or parsers.

The external Rust SDK consumer is checked separately under
`tests/rust-sdk-consumer`. CLI scenarios execute the Rust binary directly while
Node SDK scenarios import only the package export, preserving independent
black-box boundaries and reviewed golden expectations.

The fixture preload drives the compile-time-only Rust judge transport and
records prepared request metadata. Production builds cannot enable that
transport, and native clean-consumer tests exercise release builds separately.

```sh
bun run build:judge
node judge/run.mjs --product-root packages/node --cli-bin target/debug/ytm
node judge/run.mjs --product-root packages/node --surface node
bun run judge:broken
```

The optional `--surface node` filter runs the complete Node SDK, binding, and
package contract without invoking the standalone CLI. Scenario-name filters
remain available for focused debugging only.

`judge:broken` copies the built package, corrupts the public source envelope,
and proves that the approved golden result rejects the mutation.

[`golden-results.json`](golden-results.json) is the reviewed public-conformance
oracle. After an intentional public-contract change, regenerate it only with a
complete run:

```sh
node judge/run.mjs --update-golden
```

Review every changed golden result before committing the updated oracle.
