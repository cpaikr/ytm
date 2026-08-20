# Release

Release Please is the only version authority for `@sjunepark/ytm` and
`kisnet-ytm`. It owns their linked versions and generates package versions,
changelogs, lock versions, the manifest, component tags, and release notes.

For every release, confirm the exact version for both components and obtain
explicit approval before merging the combined release PR. Do not manually edit
Release Please-owned output as a fallback.

## Repository release model

`release-please-config.json` owns two components in one linked-version group:

- `packages/node` → component `node` → tag `node-vX.Y.Z`
- `packages/python` → component `python` → tag `python-vX.Y.Z`

A releasable change to either package advances both components to the same
version in one combined release PR. The bootstrap SHA is the historical
`v0.1.1` release commit; the old unprefixed tags remain historical only.

Shared source-contract changes must update both package attribution hashes in
the same releasable commit. Run this before committing a change under
`contracts/kisnet`:

```sh
bun run contracts:sync
bun run contracts:check
```

Prefer a squash merge or another merge mode that keeps the shared fixture and
both generated hash paths in the same Conventional Commit. Release Please
splits commits by package path; a separate non-releasable hash-only commit does
not attribute an earlier root-only contract commit to either component.

While the product remains pre-1.0, the configured Release Please policy treats
ordinary `feat:` and `fix:` commits as patch releases and reserves a minor bump
for breaking changes. Mark breaking changes with `!` or a `BREAKING CHANGE:`
footer. The linked group then applies the highest required bump to both
packages.

## Release hold

The Release Please job runs only when the Actions repository variable
`RELEASE_PLEASE_ENABLED` is exactly `true`. Set it to false to pause release-PR
creation. Changing the variable does not publish or merge anything; the
generated release PR remains the review gate.

## External publisher configuration

These administrator-owned settings must remain aligned with the workflows:

1. Keep `RELEASE_PLEASE_TOKEN` configured with Contents and Pull requests
   read/write access. Release Please-created component tags must be able to
   trigger the publishing workflows.
2. Keep GitHub environments named `npm` and `pypi`. Review their protection
   rules before merging; without an approval rule, publication starts
   immediately after Release Please creates the component tags.
3. Configure the npm package `@sjunepark/ytm` with this trusted publisher:
   - provider: GitHub Actions
   - owner: `sjunepark`
   - repository: `ytm`
   - workflow: `release.yml`
   - environment: `npm`
   - permission: publish
4. Configure the PyPI project `kisnet-ytm` with this trusted publisher:
   - owner: `sjunepark`
   - repository: `ytm`
   - workflow: `release-python.yml`
   - environment: `pypi`
5. Protect `main` with the Node validation check, Python quality check, all
   supported-version Python test jobs, and the Python package-build check.
   Include administrators, require conversation resolution, and disable force
   pushes and deletion. Update required check names if workflow job names
   change.

Both publisher workflows use OIDC and require no long-lived npm or PyPI publish
token. The npm workflow filename stays `release.yml` to preserve the existing
publisher identity; the PyPI identity is bound to `release-python.yml`.

## Automated flow

1. Land releasable work on `main` with an accurate Conventional Commit.
2. With `RELEASE_PLEASE_ENABLED=true`, `.github/workflows/release-please.yml`
   opens or updates one combined release PR. Review both package versions, both
   changelogs, the manifest, `bun.lock`, and `packages/python/uv.lock`.
3. Confirm the exact shared version explicitly before merging that specific
   release PR.
4. After merge, Release Please creates `node-vX.Y.Z` and `python-vX.Y.Z` plus
   their GitHub Releases.
5. `release.yml` validates the Node tag and cross-package version equality,
   rebuilds and checks the npm package, then publishes `@sjunepark/ytm`.
6. `release-python.yml` validates the Python tag and version equality, runs the
   locked Python gates, builds and clean-installs the wheel, promotes those exact
   artifacts, then publishes `kisnet-ytm` with uv.

The tag workflows publish only their own registry package, avoiding duplicate
cross-tag races. Both are version-scoped and idempotent: npm checks the registry
before publishing, and uv uses PyPI's simple index to skip files that already
exist.

Before confirming a future release that changes Python support or curl-cffi,
verify wheel availability for every advertised Python and operating-system
target. Keep both trusted publisher identities synchronized with workflow,
repository, and environment renames.

## Read-only validation

```sh
bun install --frozen-lockfile
uv sync --locked --project packages/python
bun run validate
bun run test
bun run build
bun run pack:node
bun run pack:python
```

`bun run release:check` asserts package/manifest/lock version equality, linked
component names, baseline bootstrap, package-local changelogs, lock updater
paths, tag routing, environment gates, artifact promotion, and OIDC publishing.

To retry publication for an existing component tag without moving it, manually
dispatch the corresponding workflow with that exact tag. Never create or move a
tag by hand to repair a failed publication; fix the workflow and rerun the
existing tag instead. Manual dispatch resolves only the `refs/tags/` namespace,
and every downstream validation or publication job uses the commit resolved by
the metadata job rather than resolving the tag again.
