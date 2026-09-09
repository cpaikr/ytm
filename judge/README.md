# Public-product judge

The judge runs the standalone Rust `ytm` binary and the built
`@sjunepark/ytm` client interface in isolated processes. It does not import the
Rust core, binding internals, request builders, or parsers.

The external Rust SDK consumer is checked separately under
`tests/rust-sdk-consumer`. CLI scenarios execute the Rust binary directly while
Node SDK scenarios import only the package export, preserving independent
black-box boundaries and reviewed golden expectations.

An environment-selected, feature-gated Rust fixture transport records prepared
request metadata during judge runs. Release artifacts cannot compile that
transport or the guarded numeric-loopback HTTP origin override used by recovery
tests. Native clean-consumer tests exercise release builds separately.

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
[`history.mjs`](history.mjs) supplies the history public-surface scenarios;
[`history-cli-lifecycle.py`](history-cli-lifecycle.py) verifies executable
history export, POSIX interrupts (including first and repeated Ctrl-C with
blocked output), and terminal progress as part of `bun run test`;
[`retrieval-recovery.py`](retrieval-recovery.py) drives synthetic real-HTTP
recovery, exhaustion, deadlines, and protected export through CLI/Node in
`bun run test:surfaces` and installed Python sync/async clients in
`bun run validate:python`;
[`golden-results.json`](golden-results.json) owns the reviewed public-result
oracle; and [`../contracts/kisnet/cases.json`](../contracts/kisnet/cases.json)
owns the observed wire fixtures and evidence cases. There is deliberately no
`judge/scenarios.json` coverage manifest: it was unused parallel authority.
Contract validation fails if that path reappears, so new coverage belongs in
the executable judge or the wire-evidence manifest that owns it.

Excel scenarios run in temporary child working directories and check captured
requests separately from golden stdout/stderr. They compare workbook values
with fixture-backed JSON results while checking types, literal text, layout,
provenance, fallback ordering, preflight rejection, and preserved files.
[`inspect-xlsx.py`](inspect-xlsx.py) independently reads compressed ZIP and
OOXML using the Python standard library (`PYO3_PYTHON`, or `python3`). It resolves
worksheet relationships, shared/inline strings, types and styles, and rejects
formulas and external links. Raw ZIP bytes and timestamps are not goldened.
Python is a validation dependency only. Full application compatibility is
checked separately by opening a synthetic workbook in Excel.

The exact standalone candidate consumer also exports undated kinds, checks
receipt and ZIP identity, exercises overwrite, and verifies failed replacement
of an exclusively locked workbook on Windows or permission-denied directories
on Unix. No Excel, Python, or Node runtime is needed by the product binary.

`judge:broken` copies the built package, corrupts the public source envelope,
and proves that the approved golden result rejects the mutation.

[`golden-results.json`](golden-results.json) is the reviewed public-conformance
oracle. After an intentional public-contract change, regenerate it only with a
complete run:

```sh
node judge/run.mjs --update-golden
```

Review every changed golden result before committing the updated oracle.
