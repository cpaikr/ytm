# CLI release migration

Status: implementation and local validation complete; hosted certification not run

## Selected outcome

Use local `release-it` preparation and pushed-tag publication, following
`krx-cli`, while retaining certification on every supported CLI target.
GitHub Releases distribute only CLI archives, installers, and checksums.
Remove Release Please and npm/PyPI publication; keep SDK source, local
packaging, and development CI. Historical published artifacts remain intact.

## Delivered implementation

- Local version/changelog preparation synchronizes all language version copies
  and runs the complete repository gate before commit, tag, and push.
- Tagged CI verifies source identity and every exact CLI consumer before the
  publisher uploads and verifies immutable GitHub assets.
- Manual dispatch certifies only; release variables, environment gates, and
  registry publishing paths are removed from the workflow.
- Node/native packages are private; SDK packaging remains development-only.
- The bounded code review completed; affected docs now route operations to
  [the release runbook](../docs/release.md).

## Validation and delivery

- Complete `bun run validate` passed using CPython 3.11.
- `bun run release:check` passed, including real release-it preparation in a
  disposable Git repository. Failed validation creates no commit, tag, or push;
  successful preparation commits all synchronized versions and the validation
  marker before pushing to a local fixture remote. Resolved dependencies stay
  unchanged.
- Publication tests cover interrupted upload, draft visibility recovery,
  changed tags, conflicting bytes, and read-only completed-release retries.
- Actionlint, `git diff --check`, bounded code review, and scoped documentation
  reconciliation passed.

Hosted cross-platform certification and a real release have not run for this
migration. No actual release version has been selected, no real tag pushed,
and no external settings changed. The next delivery check is a certification-only
manual `release.yml` run after the changes reach GitHub.
