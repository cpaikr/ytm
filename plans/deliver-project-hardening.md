# Deliver project hardening

Status: planned

## Outcome

The existing CLI, Node boundary, and XML parser hardening is reviewed, validated,
and integrated into `dev`, preserving its individual commit and regression
coverage. Downstream Python work starts from the accepted core behavior.

## Current state

At planning time, `codex/project-hardening` is clean and contains commit
`e6c63503cd5c7d59a617129870b147ed2b8b13db`, one commit beyond local and remote
`dev` (`e3b42e4`). The commit is not available on GitHub and there is no open PR.
Its commit message records a successful `bun run validate` with 120 conformance
scenarios and an independent review; this is recorded evidence, not a fresh
validation run by this planning task.

## Delivery scope

- CLI help accepts inline option values and counted pretty flags while
  preserving duplicate-option checks and domain validation.
- Node error-name lookup uses own properties, including for prototype-key
  error codes, and preserves the serialized string contract.
- XML structural padding accepts only XML whitespace while preserving scalar
  text and valid open content.
- Existing process regressions, golden expectations, and SPEC changes travel
  with the fixes. No unrelated SDK, release, or provider work is included.

## Execution and acceptance

- [ ] Refresh branch/remote/PR evidence and inspect the exact diff against
  `dev`; preserve unrelated work and avoid duplicating an already delivered PR.
- [ ] Reconcile the existing validation/review record with the exact commit.
  Run required checks lacking trustworthy evidence and checks needed by any
  new edits; the complete gate is `bun run validate`.
- [ ] Run one bounded code review of the delivery diff and reconcile affected
  documentation. Fix actionable in-scope defects and validate changed behavior.
- [ ] When delivery is authorized, push the branch and create a PR targeting
  `dev`, with the initial CodeRabbit review and concrete validation evidence.
- [ ] Resolve required CI and actionable review feedback. Recheck only where
  new edits, failures, or remaining concerns justify it.
- [ ] When integration is authorized, merge preserving the individual commit;
  verify remote `dev` contains the accepted change and record the PR and SHA.
- [ ] Mark this item complete and remove its active roadmap link.

Completion requires accepted remote integration and successful required checks,
not merely a local commit or PR creation. No release or production enablement
is part of this item. This plan itself authorizes no push, PR, or merge.

## Next action

On execution authorization, refresh `dev` and PR evidence and inspect the
existing commit's validation record before preparing its delivery diff.
