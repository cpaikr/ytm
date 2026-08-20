# XML Protocol Hardening

Status: superseded by [`plans/rust-node-rewrite.md`](../../plans/rust-node-rewrite.md).
The remaining live-response metadata check is absorbed by the rewrite's
transport qualification and live-validation gate.

## Purpose

Harden KIS-NET Nexacro XML handling consistently across Node and Python. Replace
Node's regex response parser with strict `@xmldom/xmldom` parsing, retain
Python's standard-library `ElementTree`, and make resource limits, namespace
rules, structural validation, and error classification part of the shared
executable contract.

## Current state

- `contracts/kisnet` is the versioned behavior contract consumed by both
  packages; `SPEC.md` defines the shared source semantics.
- Node uses a bounded streamed reader with fatal UTF-8 decoding, then parses once
  through internal `src/nexacro.js` with strict diagnostics, namespace-aware
  direct traversal, duplicate/depth checks, and DOCTYPE rejection. The only
  ignored xmldom warning is its false positive for literal XML-valid U+FFFD.
- Python uses a bounded curl content callback with fatal UTF-8 decoding and a
  strict `ElementTree` target that rejects DTDs and excessive depth during
  parsing. Its namespace, direct-child, duplicate, scalar, and error-ordering
  rules match Node. No `lxml` dependency is needed.
- Keep public result shapes, fallback behavior, error classification, and the
  escaped fixed request templates stable.
- Both runtimes execute the shared valid/invalid XML fixtures and generated
  byte-limit, encoding, BOM, U+FFFD, depth, and transport-boundary cases.
- Transport policy: accept well-formed XML 1.0 encoded as UTF-8, including a
  single UTF-8 BOM; cap the decompressed payload at 1,048,576 bytes before text
  decoding. Scheduled and manual live checks monitor upstream compatibility.

## Shared XML contract

- Accept either a default namespace or any prefix bound to
  `http://www.nexacroplatform.com/platform/dataset`.
- Require the root and protocol elements to resolve to that namespace; reject
  missing or incorrect namespaces instead of matching local names alone.
- Reject `DOCTYPE` entirely. Do not load DTDs, resolve external resources, or
  accept application-defined entities. Continue accepting XML's built-in and
  XML 1.0-valid numeric character references.
- Require exactly one `ErrorCode` parameter. Validate it before requiring the
  requested dataset because protocol-error responses may omit datasets.
- Permit at most one `ErrorMsg` and one `ErrorMessage`; preserve the existing
  fallback order when selecting the protocol message.
- For a zero status, require exactly one dataset with the requested `id` and
  exactly one direct `Rows` container.
- Read direct `Row` children and their direct `Col` children. Require every
  `Col` to have a nonempty unique `id` within its row.
- Treat self-closing `Col` as an empty string. Combine text and CDATA content,
  but reject nested element content inside a `Col`.
- Reject duplicate matching datasets, duplicate protocol parameters, duplicate
  columns, malformed XML, unsupported encodings, excessive depth, and oversized
  bodies as source-format failures.
- Tolerate additional attributes, unknown parameters, unrelated datasets, and
  unknown columns so upstream additions do not break the source-compatible
  model.

## Implementation checklist

- [x] Update `SPEC.md` and `contracts/kisnet/cases.json` with the shared XML
  invariants before changing either parser.
- [x] Add valid shared fixtures for attribute reordering, equivalent namespace
  prefixes, epilog comments, self-closing cells, CDATA, astral entities, and
  non-recursive entity decoding. Add invalid fixtures for malformed nesting,
  namespace violations, DOCTYPE/entities, nested `Col` elements, and duplicate
  parameters/datasets/columns. Generate depth boundary cases in Node tests.
- [x] Generate exact-limit and over-limit byte-size cases with the bounded
  transport tests in both runtimes.
- [x] Make the existing Node validation consume every new fixture first and
  confirm the current regex implementation fails the characterization cases.
- [x] Add `@xmldom/xmldom` to the Node runtime dependencies and lockfile. Extract
  parsing into internal `src/nexacro.js`, copy it into `dist`, add no public
  export, and configure `onError` to stop on every actionable diagnostic.
- [x] Parse each Node response once, reject `document.doctype`, validate the
  namespace-aware structure, and remove production response regex parsing.
  Preserve raw strings and raise protocol errors before dataset validation.
- [x] Replace `response.text()` with a bounded byte reader and fatal UTF-8
  decoding. Enforce the actual decompressed byte cap and abort/cancel the body
  when the cap is exceeded; do not treat encoded `Content-Length` as the
  decoded size.
- [x] Harden Python's `ElementTree` wrapper with the same namespace, structure,
  DTD, duplicate, and encoding rules. Add a bounded `_source.py` response reader
  without logging bodies; document any curl-cffi streaming limitation honestly.
- [x] Run both implementations against the same new cases and resolve any
  behavioral divergence in the shared contract rather than with package-local
  exceptions.
- [x] Rebuild Node `dist`, sync contract hashes, inspect npm contents, and run
  `$code-review` for the Node parser slice.
- [ ] Record the live response size, namespace, declaration, and content type
  without persisting the response body when the source is reachable.
- [x] Update only user-visible package documentation if behavior warrants it,
  and run `$code-review` again after the shared transport/Python slice.

## Progress log

### 2026-07-17 — Shared contract and Node parser

- Added shared XML 1.0 semantics, 16 focused fixtures, manifest-driven Node
  cases, and generated depth/invalid-character coverage. The pre-change Node
  gate failed on legal reordered attributes as expected.
- Replaced response regex parsing with strict namespace-aware DOM parsing,
  added the runtime dependency and packaged internal module, and preserved
  protocol-error ordering and public result/error shapes.
- Validation: `bun run test:node`, `bun run test:python` (50 passed, 3 live
  skipped), `bun run validate`, `bun run pack:node`, Node-runtime parser probe,
  and `git diff --check` passed.
- Review applied explicit XML 1.0 character/reference validation after xmldom
  was shown to accept forbidden code points.

### 2026-07-17 — Bounded transport and Python parity

- Added measured 1 MiB response caps and fatal UTF-8 decoding. Node cancels
  oversized decoded streams; Python aborts curl writes via a bounded content
  callback so curl-cffi cannot queue an unbounded body.
- Hardened Python parsing to match Node and made both runtimes execute the shared
  XML cases plus exact-limit, overflow, BOM, encoding, U+FFFD, and depth checks.
- Applied review fixes for a leading BOM, XML version declarations, and xmldom's
  literal-U+FFFD warning. Public result shapes and error categories are unchanged.
- Final review corrected curl-cffi's HTTP-200 write-abort classification and
  removed Node's encoded `Content-Length` shortcut so the documented measured,
  decompressed-byte boundary is authoritative. Re-review found no remaining
  actionable issues.
- PR follow-up review tightened full XML-declaration grammar in both runtimes,
  made Node reject unbounded non-streaming response implementations, derived
  depth coverage from the shared contract, and validated message scalars even
  on zero status. The locked curl-cffi `RequestException` hierarchy was also
  covered directly to confirm write-abort errors reach the existing handler.
- Validation: the full test and validation gates passed (90 Python tests passed,
  3 opt-in live tests skipped), as did the Node dry-run package and rebuilt
  Python sdist/wheel checks.
- Live verification was attempted without retaining a response body, but the
  environment could not resolve `kis-net.kr`; no live response metadata was
  available to record.
- Follow-up: rerun the opt-in live verification from an environment where
  `kis-net.kr` resolves, then record response size, namespace, declaration, and
  content type as non-gating compatibility evidence.

## Files to inspect first

- `SPEC.md` and `contracts/kisnet/`: shared behavior and fixtures.
- `packages/node/src/toolset.js`: transport, status handling, and parser seam.
- Node validation/build scripts: fixture coverage and source-to-dist copying.
- Python `_nexacro.py` and `_source.py`: parsing and response buffering.
- Python contract/property tests: deterministic and generated coverage.

## Validation

- `bun run contracts:sync` after changing shared cases or fixtures.
- `bun run test:node` after each Node parser/build change.
- `bun run test:python` after each Python parser/transport change.
- `bun run validate` and `bun run test` for the cross-package gate.
- `bun run pack:node` to confirm the internal parser module and runtime
  dependency are publishable.
- `git diff --check` before review.
- Run the opt-in live smoke only after deterministic tests pass; record actual
  response size, namespace, declaration, and content type without persisting the
  source body.

## Risks and edge cases

- `@xmldom/xmldom` reports some malformed constructs below fatal severity by
  default. Strict `onError` configuration is mandatory and must be tested.
- XML parsing proves well-formedness, not the Nexacro application schema. Keep
  structural checks explicit and fail closed on ambiguous duplicates.
- Namespace prefixes are arbitrary; compare namespace URIs and local names,
  never literal qualified names.
- `Content-Length` can describe the encoded representation while Fetch exposes
  decoded bytes. Enforce the measured decompressed body size while reading.
- Python uses curl-cffi's content callback rather than `stream=True`; the latter
  can queue data ahead of the consumer and is not a hard memory bound.
- Stricter namespace enforcement could expose a live upstream variant not in
  fixtures. Use opt-in live verification to detect variants, but do not weaken
  the contract without capturing and documenting the variant.
- Preserve unrelated working-tree changes and regenerate only owned build or
  contract artifacts.

## Decisions and rejected alternatives

- Chosen: `@xmldom/xmldom` for Node because the response is a small buffered,
  namespace-bearing tree and DOM exposes `localName`/`namespaceURI` directly.
- Rejected for now: `fast-xml-parser`; it requires separate strict validation,
  careful scalar/array configuration, and has weaker namespace URI semantics.
- Rejected for now: `saxes`; strict and namespace-aware, but its archived
  event-driven API adds a state machine without a current streaming need.
- Rejected: `xml2js`, legacy `sax`, and native `libxmljs2` due to weaker
  strictness, legacy object shapes, or native/Node-version burden.
- Rejected: adding `lxml` to Python. `ElementTree` is sufficient for this fixed
  protocol once application and resource policies are explicit.
- Chosen: a 1 MiB decompressed-payload limit. It is roughly three orders of
  magnitude above current responses while still bounding memory and parser work.
- Chosen: curl-cffi's write-abort sentinel for Python because callback delivery
  enforces the cap before library-level response buffering.
