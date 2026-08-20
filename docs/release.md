# Release

Release automation is intentionally disabled. The repository has no Release
Please workflow, and no process should create release PRs or tags until a
release procedure is explicitly chosen and reviewed.

The existing Release Please config and manifest remain only as dormant metadata
for the current `0.2.0` Node/Python line. They do not authorize automation,
manual version edits, tags, GitHub Releases, or publication.

## Node-only cutover design

The lockstep model below remains active until the final rewrite cutover. The
cutover changes release ownership atomically; none of these target-state claims
apply to the current `0.2.0` line.

- The dormant Release Please config, manifest, and linked-version assumptions
  will be removed with the Python product. A future Node release procedure is
  deliberately deferred; it must keep one version across the root package and
  native packages and retain the `node-vX.Y.Z` tag namespace.
- The existing `release.yml` filename, `npm` environment, trusted-publisher
  identity, package name, and Node component tag namespace remain stable.
- Release assembly will build the exact targets selected in
  [`native-targets.json`](../native-targets.json) on their native runners. It
  will project the one explicitly approved version into disposable platform
  package manifests, collect the exact native artifacts, and reject any
  missing, duplicate, or mismatched target/version before publication can run.
- Every selected target must install the packed root package in a clean native
  consumer and verify executable discovery, `./toolset` import, capabilities,
  validation, native loading, and network-free error/exit behavior. The
  corresponding compile-time judge build must pass fixture execution on the
  same target and commit; its fixture feature is absent from the packed release
  binary. A cross-build alone is not a support claim.
- Platform packages publish before the root package; the root artifact may
  reference only the exact same version. Registry idempotency checks apply to
  every artifact. A partial publish is repaired with a new explicitly approved
  version, never by moving a tag or replacing an immutable
  package version.
- `release-python.yml`, the `pypi` environment dependency, Python metadata
  checks, and Python entries in release validation are removed from the active
  repository. The historical PyPI project and Python tags are not changed or
  deprecated by the cutover.

The final rewrite is breaking: it removes the Python product, removes the
toolset's JavaScript `context.fetch` transport seam, raises the minimum Node
major to 22, and narrows the native platform claim. Its eventual main-branch
merge must carry an accurate `!` or `BREAKING CHANGE:` release input. The next
version is not selected by this plan. It must be reviewed and explicitly
confirmed before any tag, GitHub Release, or publication.

## Repository release model

The dormant `release-please-config.json` describes two components in one
linked-version group:

- `packages/node` → component `node` → tag `node-vX.Y.Z`
- `packages/python` → component `python` → tag `python-vX.Y.Z`

It records the previous automated model but no workflow consumes it. The
bootstrap SHA is the historical `v0.1.1` release commit; the old unprefixed
tags remain historical only.

Shared source-contract changes must update both package attribution hashes in
the same releasable commit. Run this before committing a change under
`contracts/kisnet`:

```sh
bun run contracts:sync
bun run contracts:check
```

Keep shared fixture and both generated hash paths in the same reviewed commit
while both legacy packages remain. Continue to mark breaking changes with `!`
or a `BREAKING CHANGE:` footer so future release planning has accurate history.

## External publisher configuration

These administrator-owned settings must remain aligned with the workflows:

1. Keep GitHub environments named `npm` and `pypi`. Review their protection
   rules before merging; without an approval rule, publication starts
   immediately after a matching component tag is pushed.
2. Configure the npm package `@sjunepark/ytm` with this trusted publisher:
   - provider: GitHub Actions
   - owner: `cpaikr`
   - repository: `ytm`
   - workflow: `release.yml`
   - environment: `npm`
   - permission: publish
3. Configure the PyPI project `kisnet-ytm` with this trusted publisher:
   - owner: `cpaikr`
   - repository: `ytm`
   - workflow: `release-python.yml`
   - environment: `pypi`
4. Protect `main` with the Node validation check, Python quality check, all
   supported-version Python test jobs, and the Python package-build check.
   Include administrators, require conversation resolution, and disable force
   pushes and deletion. Update required check names if workflow job names
   change.

Both publisher workflows use OIDC and require no long-lived npm or PyPI publish
token. The npm workflow filename stays `release.yml` to preserve the existing
publisher identity; the PyPI identity is bound to `release-python.yml`.

## Tag-triggered publishing

There is no workflow that creates release PRs, tags, or GitHub Releases. If a
future release is separately authorized, first document and review the exact
version-update and tag-creation procedure. After an approved tag exists:

1. `release.yml` validates the Node tag and cross-package version equality,
   rebuilds and checks the npm package, then publishes `@sjunepark/ytm`.
2. `release-python.yml` validates the Python tag and version equality, runs the
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

`bun run release:check` asserts that Release Please automation remains absent,
then checks package/manifest/lock version equality, dormant linked-component
metadata, tag routing, environment gates, artifact promotion, and OIDC
publishing.

To retry publication for an existing component tag without moving it, manually
dispatch the corresponding workflow with that exact tag. Never create or move a
tag by hand to repair a failed publication; fix the workflow and rerun the
existing tag instead. Manual dispatch resolves only the `refs/tags/` namespace,
and every downstream validation or publication job uses the commit resolved by
the metadata job rather than resolving the tag again.
