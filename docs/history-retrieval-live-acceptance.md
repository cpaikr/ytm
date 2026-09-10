# Full history retrieval live acceptance

Issue #45's full live acceptance **passed** in the single owner-authorized run
on 2026-09-10 (Korea time). This is a macOS ARM64 assessment, not a reproduction
on the original Windows x64/PowerShell host. Release publication and production
qualification remain separate and unapproved by this assessment.

## Authority and candidate

The immutable [goal contract](../goals/retrieval-live-acceptance.md) and
[issue #45](https://github.com/cpaikr/ytm/issues/45) record the owner's one-off
180-observation run, 1,800-second retrieval deadline, metadata-only retention,
and conditional closure authority. No repeat live run was performed.

Provider preflight found no newly recorded withdrawal condition in the provider
policy or open issue records. The latest existing scheduled smoke runs
[34317143294](https://github.com/cpaikr/ytm/actions/runs/34317143294),
[34192715819](https://github.com/cpaikr/ytm/actions/runs/34192715819), and
[34089482226](https://github.com/cpaikr/ytm/actions/runs/34089482226) succeeded.
These records support the bounded test decision; they do not resolve the
[provider qualification](provider-qualification.md) unknowns or establish rights.

| Candidate field | Recorded value |
| --- | --- |
| Source commit | `1170721a4a77595190a74667e5b1fbc1f9bcce49` |
| Reported version | `ytm 0.4.1` |
| Executable SHA-256 | `024792f22666c0be4ac4cc45f75ade7ffa02af12785d54de2e6f158f1ecc7f02` |
| Platform | `macOS-26.5.2-arm64-arm-64bit` |
| Shell | `/bin/zsh 5.9` |
| Exact executable | `ytm` |

The current checker requires an independently generated provenance sidecar
binding `sourceCommit`, `binarySha256`, and `version` to the supplied candidate;
it verifies the binary digest before invoking the candidate.

Built with `cargo build --release --locked -p ytm-cli --no-default-features`.
The source contains PR #46 merge `f6056a4` and validation fixes `51bfca4`.
The release fixture guard confirms judge routing cannot be enabled in release
artifacts. The runner removed routing/proxy environment overrides; no installed
binary, release, tag, or product source was changed.

## Run and acceptance

The exact executable above was invoked once with:

```text
history --end-date 2023-06-30 --count 180 --format json --operation-timeout-seconds 1800
```

| Run field | Recorded value |
| --- | --- |
| UTC start | 2026-09-09T23:19:12.307329+00:00 |
| UTC end | 2026-09-09T23:20:13.091891+00:00 |
| Elapsed process time (seconds) | 60.783 |
| Configured retrieval deadline (seconds) | 1800 |
| Requested observations | 180 |
| Selected observations | 180 |
| Scanned calendar dates | 261 |
| CLI exit code | 0 |

Elapsed time includes CLI startup, retrieval, serialization and in-memory
checking; it is not an isolated transport measurement. The separate 1,860-second
process watchdog did not fire.

| Acceptance check | Outcome |
| --- | --- |
| Exit 0 and exactly one successful history JSON envelope | Pass |
| Exactly 180 unique ascending selected dates, all at or before 2023-06-30 | Pass |
| Contiguous scan metadata agrees with the selected lower boundary and stays within 2,000 days | Pass |
| Complete canonical category code/name coverage, ordered per date; extra categories unique | Pass |
| Exact requested/actual dates, no fallback; unavailable pairs retain the existing matrix-unavailable contract | Pass |
| Source origin, endpoint, method, request metadata, date and category provenance unchanged | Pass |
| Each selected day has a finite numeric normalized yield; zero/negative values qualify and nulls do not | Pass |
| Available/unavailable pair and data-row counters agree with the result | Pass |

The public discovery records expose only date and availability. They cannot
independently reveal omitted live-only categories or original discovery order.
Complete enumeration therefore also relies on the inspected core `history_day`
loop and the passing synthetic `count_180_stops_at_target_and_orders_whole_dates`
test, which verifies canonical plus discovered categories and exact request
counts. No extra provider lookup was made to duplicate discovery.

No terminal error occurred. The assessed candidate did not expose successful
retry counts, and they were not inferred. This run validates this candidate and
scenario within the deadline; it establishes no general latency or quota claim.

## Validation and retention

- [Checker](../scripts/check-history-live-acceptance.py) and
  [synthetic tests](../scripts/test-history-live-acceptance.py): nine test methods
  with full-count success, ordinary unavailable pairs, and rejection cases for
  shortened/duplicate/unordered/future dates, scan/discovery gaps, missing or
  relabeled categories, source drift, fallback, counters, invalid numerics,
  malformed/error envelopes, and redaction. Both normal and optimized Python
  runs passed.
- `cargo test --locked -p ytm-core --test history`: all ten tests passed, including
  full-count canonical/live-only coverage, unavailable data, cancellation and
  fatal-error preservation.
- Release fixture guard passed with Python 3.13. Its initial system-Python 3.9
  invocation failed interpreter preflight; selecting the supported interpreter
  resolved it without product changes.
- Independent bounded checker review is clean after canonical category-name
  validation was added. Acceptance checks use explicit conditions, unaffected
  by Python optimization; nested terminal HTTP status uses `sourceActual`.
- Raw CLI stdout was piped directly to the checker and held in bounded memory; stderr
  was discarded. Only candidate identity, timing, counts and fixed check
  outcomes were retained. No provider bodies, rows, yields or request bodies
  were printed or persisted. The exclusive run reservation remains in the
  local build directory as an additional duplicate-attempt guard.

Independent final evidence review found no actionable issues and confirmed
the candidate hash, ancestry and every recorded check. [Issue #45 evidence](https://github.com/cpaikr/ytm/issues/45#issuecomment-5610130717)
records the remote outcome; the final acceptance criterion was checked and
the issue closed as completed. Local commits are retained for later reviewed
aggregation under no-PR delivery.
