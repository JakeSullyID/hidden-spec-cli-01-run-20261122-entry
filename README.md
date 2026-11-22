# hidden-spec-cli-01-run-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JakeSullyID/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JakeSullyID/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts patch.diff
```

## What it does

`mend` applies AI-written edits to a tree of files, in four formats, per `SPEC.md`:

- **Unified diffs** — with wrong line numbers, missing files, renames, creations, deletions, CRLF, and no-newline-at-end-of-file handling.
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, with path inheritance across blocks.
- **V4A patches** — `*** Begin Patch` / `*** Update File` / `*** Add File` / `*** Delete File` / `*** Move to` / `*** End of File`, with anchor search and cursor tracking.
- **JSON tool calls** — `create`, `str_replace`, and `insert` (single object, array, or JSON Lines).

Matching is three-tier (exact, whitespace-insensitive, indent-insensitive) with nearest-to-target selection; ambiguous matches are reported, never guessed. All-or-nothing writes: any failed edit means no file changes. `node main.ts --check patch.diff` verifies without writing; `--strict` disables the fuzzy tiers.

```sh
node main.ts --check patch.diff   # verify only, no writes
node main.ts --strict patch.diff  # exact matching only
node main.ts --format=json -      # read a JSON patch from stdin
```

Node 22 standard library only; no dependencies. `SPEC.md` is the whole specification, `check.ts` runs the 100 public practice checks.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
