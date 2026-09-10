# CLI release migration

Status: original migration certified; subsequent CI cost policy is documented in
[the release runbook](../docs/release.md#ci-platform-policy).

## Original migration outcome

Use local `release-it` preparation and pushed-tag publication, following
`krx-cli`, while retaining certification on every supported CLI target.
GitHub Releases distribute only CLI archives, installers, and checksums.
Remove Release Please and npm/PyPI publication; keep SDK source, local
packaging, and development CI. Historical published artifacts remain intact.

## Original delivered implementation

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
- Executable regression coverage exercises Ctrl-C while history output is
  blocked: the first interrupt after retrieval and a repeated interrupt during
  cancellation exit 130. The signal monitor remains active through output.
- Publication tests cover interrupted upload, draft visibility recovery,
  changed tags, conflicting bytes, and read-only completed-release retries.
- Actionlint, `git diff --check`, bounded code review, and scoped documentation
  reconciliation passed.

## Hosted delivery evidence

- Full-platform [CI run 34181314759](https://github.com/cpaikr/ytm/actions/runs/34181314759)
  passed on candidate commit `7be5832961c3b915e8abeab6e68a2d82292d6b0c`.
- [PR #36](https://github.com/cpaikr/ytm/pull/36) integrates the candidate into
  protected `main`. Direct pushes were rejected even after the exact commit's
  required checks passed; release delivery uses the PR path and preserves commits.
- The selected release is `0.3.0`. Its
  [GitHub Release](https://github.com/cpaikr/ytm/releases/tag/v0.3.0) and
  [release workflow runs](https://github.com/cpaikr/ytm/actions/workflows/release.yml)
  are authoritative for publication and artifact-certification status.

The [runbook](../docs/release.md#prepare-a-release) defines the release
sequence: prepare without push, merge the certified release commit through a
PR, push its original tag after confirming ancestry on `origin/main`, and
manually dispatch certification and publication on that tag.
