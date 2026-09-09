# Consult Mytech Evaluation

## Contract and version

Create a source skill for other coding projects to consult current mytech
preferences and assess scoped decisions. Use explicit invocation; apply edits
only under the underlying task's authority. These recommended defaults were
stated during clarification; no different preference was received.

The runtime package consists of `SKILL.md` and optional Codex invocation policy.
The repository remains an external input. No installation, publication,
predecessor removal, or technical preference change was performed.

The source package now lives at `skills/consult-mytech/`, following the
distributable-source convention in agent-scripts. Its runtime and recorded trial
files were moved without content changes. Paths inside raw trial records name
the original evaluation location and are preserved as evidence. The README
routes consumers to the current source location.

Relocation validation: `bunx skills add ./skills --list` discovered
`consult-mytech`; metadata validation, focused Markdown lint, and whitespace
checks passed at the new location. A bounded review and scoped documentation
harmonization found no remaining active references to the old location. Runtime
content and invocation policy are unchanged, so behavior and trigger trials
were not repeated for this directory move.

Candidate SHA-256:
`381beeedf0c4aeba9db414fe4bd9e4775d3b95cc14e4537ce18bc77be6b23534`.
Guidance baseline: mytech HEAD
`03153f357c8645624c7a0239dfab3356ad2bf13a`. Scored runs include the local README
navigation addition; consulted guidance documents were unchanged.

## Behavior evidence

[Cases and frozen assertions](cases.json) define an unscored observation pair,
then three scored baseline/candidate pairs in fresh contexts. Inputs are
synthetic project descriptions with real repository guidance. The holdout uses
a deliberately unavailable source and an independent code question. No candidate
revision was made after observing the holdout.

The observation pair produced equivalent Python integration advice. The
candidate additionally reported source revision, local changes, freshness, and
coverage limits. Assertions were frozen after that observation, before scored
trials. [Scores](scores.json) preserve individual dispositions and reasons.

| Scored case | Baseline | Candidate | Observed difference |
| --- | --- | --- | --- |
| Constrained CLI review | 5/6 | 6/6 | Candidate identifies inspected revision, local changes, and freshness limits |
| Desktop proposal boundary | 5/6 | 6/6 | Both reject draft mandates; candidate also supplies source provenance |
| Unavailable-source holdout | 4/5 | 5/5 | Both diagnose independent bug; candidate also requests the input needed to resume consultation |

Both conditions preserved substantive advice and authority in every case.
Candidate passed all 17 assertions; baseline passed 14. These counts establish
the observed differences, not general reliability. Raw answers and work logs
are retained in the paired `observation-`, `cli-`, `desktop-`, and `missing-`
JSON files. One trial per behavior condition was used; no observed failure or
instability justified another behavior round.

Candidate adds a skill read and Git provenance operations. The CLI candidate
also read an adjacent distribution document without making unsupported delivery
recommendations; this is a small unnecessary read, not a scope expansion.
Recorded clocks and operation definitions cover different intervals, so a speed
comparison is unsupported. Retain the candidate for the consistent source and
coverage reporting while preserving the baseline's correct advice.

## Selection evidence

[Trigger cases](triggers.json) freeze three explicit positives and five
uninvoked, adjacent, unrelated, or ambiguous negatives. Each prompt is presented
alone to a fresh worker in each of two repetitions. Raw labels and responses are
retained in `trigger-run-1.json` and `trigger-run-2.json`.

Both repetitions passed all eight cases: all six explicit-positive trials
activated and all ten negative trials rejected activation. No false positives,
missed positives, or disagreement between repetitions was observed.

This tests interpretation of the description and explicit policy. It does not
prove installation or actual host catalog behavior.

## Review and validation

One independent bounded code-review pass applied implementation, system,
design, and diet lenses plus the authoring and portability contracts. No
actionable findings remained. [Rubric dispositions](authoring-review.json)
record the integrated checks. No scripts, bundled guidance copies, migration,
or additional runtime abstractions were needed.

Scoped harmonization checked the skill, policy, evidence, and README navigation.
The README links to the skill source without claiming installation. Preferences
remain owned by their existing documents; no history entry is warranted.

- Skill metadata validator: passed.
- Focused Markdown lint and diff whitespace check: passed.
- Repository guidance contract and four existing regression tests: passed.
- Unsettled-guidance query: passed; existing drafts remain drafts.
- Repository-wide Markdown lint: blocked by 42 pre-existing issues across
  context7-cli, explore-repo, and develop-skills files and their mirrored paths.
  Those unrelated files were left unchanged.

## Limits

No real consuming-project implementation, authorized-edit branch, remote
retrieval fallback, or ambiguous-location scenario was exercised. Global
installation and live host invocation remain unverified and outside this source
creation. Synthetic behavior trials and selection simulations are the evidence
for this candidate, with no claim of production usage or measured speedup.
