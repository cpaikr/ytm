# Confirm the first post-migration live smoke

## Outcome

A scheduled or manually dispatched live-smoke run from a `main` revision that
contains the public Rust SDK and standalone Rust CLI succeeds, and the sanitized
evidence ledger records that operational result.

## Current state

The scheduled workflow exercises the standalone Rust CLI, but the latest
successful scheduled run predates the completed SDK/CLI migration. This is
operational availability evidence, not production qualification and not a
release-refactor prerequisite.

## Next action

After the next eligible run, verify its source SHA contains the completed
migration and review only bounded metadata. If it succeeds, update
`docs/provider-qualification.md`; if it fails, triage the provider boundary
without broadening access or retaining payloads.

