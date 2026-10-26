# Skill eval: desk-pr

Task set `evals/desk-pr.json` · 6 tasks · $0.4 ceiling per run · 600s timeout per run

Spent $0.90 of the $5 whole-run budget. The figure is claude's reported cost: on a claude.ai subscription it is plan usage, not a charge.

## body-fence

| Check | With desk-pr | Without |
|---|---|---|
| opens with desk's body marker | pass | fail |
| closes with desk's end marker | pass | fail |
| has a Changes section | pass | fail |
| has a Testing section | pass | fail |
| carries the reviewed SHA | pass | pass |
| gives the result count | fail | fail |
| no AI attribution footer | pass | pass |
| has a Before / after for a result-count change | fail | fail |
| run | ok ([transcript](transcripts/body-fence.skill.json)) | ok ([transcript](transcripts/body-fence.base.json)) |

## stray-commit

| Check | With desk-pr | Without |
|---|---|---|
| prints the diff review block | pass | fail |
| names the stray commit | pass | pass |
| does not push | pass | pass |
| run | ok ([transcript](transcripts/stray-commit.skill.json)) | ok ([transcript](transcripts/stray-commit.base.json)) |

## artefacts

| Check | With desk-pr | Without |
|---|---|---|
| prints the diff review block | pass | fail |
| takes the one-off script out | pass | pass |
| flags the Playwright output | pass | fail |
| flags the loose screenshot | pass | fail |
| run | ok ([transcript](transcripts/artefacts.skill.json)) | ok ([transcript](transcripts/artefacts.base.json)) |

## same-vendor

| Check | With desk-pr | Without |
|---|---|---|
| has a Testing section | pass | pass |
| carries the reviewed SHA | pass | pass |
| tags the refutation same-vendor | pass | fail |
| gives the rendered evidence | pass | pass |
| run | ok ([transcript](transcripts/same-vendor.skill.json)) | ok ([transcript](transcripts/same-vendor.base.json)) |

## decisions

| Check | With desk-pr | Without |
|---|---|---|
| opens with desk's body marker | pass | fail |
| has a Decisions taken section | pass | fail |
| names the call and its category | pass | pass |
| shows before and after | pass | pass |
| no AI attribution footer | pass | pass |
| run | ok ([transcript](transcripts/decisions.skill.json)) | ok ([transcript](transcripts/decisions.base.json)) |

## staging-step

| Check | With desk-pr | Without |
|---|---|---|
| has a Testing section | pass | pass |
| leaves the staging check unchecked | pass | pass |
| run | ok ([transcript](transcripts/staging-step.skill.json)) | ok ([transcript](transcripts/staging-step.base.json)) |

## Totals

| | With desk-pr | Without |
|---|---|---|
| Checks passed | 24 | 13 |
| Checks failed | 2 | 13 |
| Runs failed (not counted) | 0 | 0 |

## Verdict

Verdict: desk-pr: **keep** (the skill arm passed more checks: 24 with, 13 without)
