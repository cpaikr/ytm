# Windows installation visibility

Status: implementation, bounded review, and local validation complete; independent
Windows consumer validation remains open.

Scope: [issue #42](https://github.com/cpaikr/ytm/issues/42). Follow the accepted
mytech guidance at `c6e33a7` for CLI installation, source-to-consumer verification,
and standalone distribution. CI platform policy and unrelated issue #27 remain
outside this change.

## Decisions and implementation

- Keep the existing default and `YTM_INSTALL_DIR` override. Fresh-install output
  identifies its filesystem-view limit and provides a recovery link. Do not add
  an unvalidated physical-path detector: a local path match still cannot prove
  independent consumer usability. Report the boundary as unverified on every
  fresh Windows install instead of guessing redirection from the launcher name.
- The [Windows guide](../docs/windows-installation.md) owns recovery, persistent
  user PATH registration, separate session setup, and independent verification.
  README retains the official installer entry point and full-path checks.
- Preserve executable/receipt publication and managed-upgrade behavior. Consumer
  tests retain exact pair checks and add command discovery in current/new shells.
- Bounded `code-review` found no actionable issues. `harmonize-docs changes`
  reconciled README, the Windows guide, and the release runbook.

## Evidence and remaining work

- Incident evidence is in issue #42: AppData physical redirection was observed.
  Independent post-recovery help confirmation was for Darty, not YTM.
- `bun run release:check` passed, including guide and installer syntax and
  executed PATH transformations in PowerShell 7.6.6 on macOS. Registry I/O is
  isolated; tests cover custom paths, empty PATH, repeated registration,
  preservation of existing entries, case/quotes/trailing separators, environment
  expansion, and separate session changes. This does not test Windows registry
  persistence.
- Published v0.4.0 archives matched their published checksums. With installers
  regenerated from this checkout, the macOS ARM64 consumer suite passed native
  install, receipt identity, full-path and command-name version/help in parent
  and child shells, integrity failures, and managed-upgrade/recovery tests.
  This is a local test candidate, not a newly published release certification.
- Local host is macOS without a Windows shell. A bounded connection attempt to
  the available Windows machine timed out on SSH. Independent Windows physical
  visibility, registry persistence, and current/new ordinary-terminal invocation
  remain unverified. Use the guide's procedure before claiming that boundary.
- Complete `bun run validate` passed with `PYO3_PYTHON` selecting installed
  CPython 3.12 and PowerShell 7.6.6 on PATH. The initial attempt selected system
  Python 3.9 and stopped at the Python minimum-version check; correcting the
  interpreter resolved it. Changed-document local links and `git diff --check`
  also passed.
- Next: obtain independent Windows consumer evidence using the guide.
  [GitHub Releases](https://github.com/cpaikr/ytm/releases) own installer-message
  publication status; immutable v0.4.0 assets remain unchanged.
