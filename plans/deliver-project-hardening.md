# Deliver project hardening

Status: in progress

## Outcome

The existing CLI, Node boundary, and XML parser hardening is reviewed, validated,
and integrated into `dev`, preserving its individual commit and regression
coverage. Downstream Python work starts from the accepted core behavior.

## Current state

The original hardening commit `e6c63503cd5c7d59a617129870b147ed2b8b13db`
is preserved on `codex/python-sdk-hardening-delivery`, together with the
previously local planning merge. Remote `dev` contains the durable goal
initialization; the implementation awaits reviewed remote integration.

Fresh `bun run validate` passed, including all 120 conformance scenarios. A
bounded four-lens code review found no actionable issues. Source and generated
Node output agree. Existing audit warnings remain non-fatal under repository
policy. Live-smoke evidence reconciliation shares this PR as documentation-only
work; no provider call was executed.

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

- [x] Refresh branch/remote/PR evidence and inspect the exact diff against
  `dev`; preserve unrelated work and avoid duplicating an already delivered PR.
- [x] Reconcile the existing validation/review record with the exact commit.
  Run required checks lacking trustworthy evidence and checks needed by any
  new edits; the complete gate is `bun run validate`.
- [x] Run one bounded code review of the delivery diff and reconcile affected
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

Finish the affected-documentation review, create the ready PR to `dev`, then
resolve CI and review feedback and merge preserving the existing commits.
