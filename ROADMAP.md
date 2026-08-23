# Roadmap

Implementation delivery is complete on `main`; no active feature plan is
recorded here.

## Current verification

The scheduled live-smoke workflow now exercises the standalone Rust CLI, but no
run from the post-migration `main` revision has completed yet. Confirm its first
successful scheduled run in [GitHub Actions](https://github.com/cpaikr/ytm/actions/workflows/live-smoke.yml),
then update the evidence ledger in
[`docs/provider-qualification.md`](docs/provider-qualification.md). This is
operational evidence, not production qualification.

## Deferred decisions

- Version selection and npm, crates.io, CLI binary, installer, tag, or GitHub
  Release publication require separate authorization; see
  [`docs/release.md`](docs/release.md).
- Production enablement and provider rights remain unresolved; see
  [`docs/provider-qualification.md`](docs/provider-qualification.md).
