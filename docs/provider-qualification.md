# KIS-NET provider qualification

## Decision

Status: **protocol-feasible; not production-qualified**.

The source can currently satisfy bounded ytm requests through the selected Rust
HTTP stack. That observation does not establish automated-use permission,
production stability, reuse rights, quotas, or support. High-volume use,
retained source bodies, redistribution, and production enablement remain
unapproved pending an explicit human rights-and-operations decision.

A bounded scheduled smoke may continue as project monitoring. It must remain
sequential, retain metadata only, and stop if any withdrawal criterion below
is met.

## Evidence ledger

| Classification | Evidence |
| --- | --- |
| Observed | The mobile YTM Matrix form and the two operations represented by `initializeYtmMatrix` and `listYtmMatrix` were inspected. |
| Observed | Scheduled legacy checks succeeded on eight runs from 2026-08-11 through 2026-08-20; those checks establish availability only. |
| Observed | GitHub issue #7 records a bounded 2026-08-04 observation: direct kind code 80 returned 13 rows for 2025-12-31 while initialization omitted it. |
| Observed | The disposable Rust feasibility run below completed both operations with rustls and no browser impersonation. |
| Inferred | The operations appear unauthenticated and read-only. This is not provider authorization or an availability commitment. |
| Project decision | Requests use the exact origin and operations in the wire authority, one at a time, within its deadline and body/parser bounds, with redirects and transport retries disabled. |
| Project decision | Previous-date lookup may attempt the requested date plus at most 31 earlier calendar dates. It advances only after confirmed empty data. |
| Project decision | Live evidence never persists raw response bodies, rows, yields, or request bodies. |

The wire facts referenced here are authoritative only in
[`contracts/kisnet/openapi.yaml`](../contracts/kisnet/openapi.yaml).

## Disposable Rust feasibility evidence

Run at 2026-08-20T05:54:15Z against commit
`81a60e01a54fc64a5c36633f3fe22999fd905edc` on macOS ARM64 with Rust 1.92.0.
The disposable crate used `reqwest` 0.13.4 with rustls and streaming
decompression, `quick-xml` 0.41.0 with strict checks, and Tokio 1.53.1. It was
outside the repository and is not product code.

| Operation | HTTP | Final location | Content type | Content encoding | Content length | Decompressed bytes | Duration | XML/profile | Datasets and row counts |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | --- |
| `initializeYtmMatrix` | 200 | unchanged | `text/xml;charset=UTF-8` | absent | absent | 4,089 | 114 ms | XML 1.0, UTF-8, no BOM, contract namespace, depth 5, ErrorCode 0 | output1: 7; output2: 3 |
| `listYtmMatrix` | 200 | unchanged | `text/xml;charset=UTF-8` | absent | absent | 3,269 | 18 ms | XML 1.0, UTF-8, no BOM, contract namespace, depth 5, ErrorCode 0 | output1: 3 |

The same binary parsed the independent init and matrix fixtures under the
selected size and depth guards. `cargo fmt --check` and Clippy with warnings as
errors passed after dependency resolution. The probe did not claim full parser
conformance; the product core must still pass every valid, invalid, generated
boundary, local HTTP, cancellation, and decompression scenario.

No response or request body was written to the repository or evidence record.
Only this sanitized metadata was retained.

## Unknowns requiring provider or owner confirmation

- Whether the site terms permit automated access and this specific reuse.
- Required attribution and limits on derived-data display or redistribution.
- Permitted retention of normalized results and source-derived raw columns.
- Request quota, concurrency or pacing limits, and acceptable fallback volume.
- Supported historical range, schema stability, media and compression
  guarantees, service-level objectives, and support channel.
- Incident contact, change notice, and withdrawal mechanism.

## Operating policy

- Ordinary product calls are sequential and do not retry transport failures.
- Matrix fallback performs initialization plus retrieval for the requested date
  and at most 31 earlier dates: a worst case of 64 sequential HTTP calls, each
  with its own deadline. That ceiling is a compatibility budget, not a pacing
  entitlement. No background bulk retrieval is approved.
- Scheduled smoke uses one known scenario and stores only the metadata fields
  demonstrated above. Logs must not include bodies or normalized rows.
- A source-format, protocol, transport, or availability drift alert blocks a
  release claim until triaged against the wire contract and independent
  fixtures.
- Incidents are handled by disabling live monitoring or distribution first;
  no alternate JavaScript transport, browser impersonation, endpoint probing,
  or automatic retry escalation is permitted.

## Withdrawal criteria

Disable live access and require a new qualification decision if the provider
objects, terms become incompatible or unclear, authentication or anti-bot
controls appear, redirects leave the allowed origin, request volume causes
observable strain, data retention cannot be justified, or repeated drift makes
safe interpretation uncertain.

Protocol success never overrides a withdrawal condition.
