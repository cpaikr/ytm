# Public-product judge

The judge runs the standalone Rust `ytm` binary and the built
`@sjunepark/ytm/toolset` surface in isolated processes. It does not import the
Rust core, binding internals, request builders, or parsers.

The external Rust SDK consumer is checked separately under
`tests/rust-sdk-consumer`. CLI scenarios execute the Rust binary directly while
Node SDK scenarios import only the package export, preserving independent
black-box boundaries and reviewed golden expectations.

An environment-selected, feature-gated Rust fixture transport records prepared
request metadata during judge runs. Release artifacts cannot compile that
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

Coverage authority is intentionally split: `judge/run.mjs` owns the executable
scenario definitions, assertions, filters, and fixture accounting;
[`golden-results.json`](golden-results.json) owns the reviewed public-result
oracle; and [`../contracts/kisnet/cases.json`](../contracts/kisnet/cases.json)
owns the observed wire fixtures and evidence cases. There is deliberately no
`judge/scenarios.json` coverage manifest: it was unused parallel authority.
Contract validation fails if that path reappears, so new coverage belongs in
the executable judge or the wire-evidence manifest that owns it.

`judge:broken` copies the built package, corrupts the public source envelope,
and proves that the approved golden result rejects the mutation.

[`golden-results.json`](golden-results.json) is the reviewed public-conformance
oracle. After an intentional public-contract change, regenerate it only with a
complete run:

```sh
node judge/run.mjs --update-golden
```

Review every changed golden result before committing the updated oracle.
