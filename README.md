# crap-check

Cyclomatic, cognitive and CRAP complexity for TypeScript and JavaScript
repositories.

`crap-check` does five things:

- It measures the working tree and names the worst functions.
- It builds a weekly history from git. It reads old commits from the object
  database, so it does not check anything out.
- It draws the history as standalone SVG charts.
- It posts the complexity delta of a pull request as one comment, and updates
  that comment on each push.
- It writes the GitHub workflows that keep the history current, on a schedule
  you choose.

```bash
npx crap-check
```

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Set up GitHub Actions](#set-up-github-actions)
- [Commands](#commands)
- [Configuration](#configuration)
- [Coverage and the CRAP score](#coverage-and-the-crap-score)
- [The metrics](#the-metrics)
- [How the history works](#how-the-history-works)
- [Output files](#output-files)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [References](#references)
- [License](#license)

## Requirements

- Node 22 or later, or Bun.
- git, with the repository cloned. `history` needs the full history, so a
  shallow clone gives fewer weeks.
- For the CRAP score, a test runner that writes an lcov report.

The package bundles its own TypeScript parser (`typescript@6.0.3`). The result
does not change with the TypeScript version of your repository.

## Install

Run it with no install:

```bash
npx crap-check --help
bunx crap-check --help
pnpm dlx crap-check --help
```

Or add it as a development dependency with an exact version:

```bash
npm install --save-dev --save-exact crap-check
bun add --dev --exact crap-check
```

The binary is `crap-check`. The examples below use the short name. With no
install, put `npx crap-check` in place of `crap-check`.

## Quick start

Run these steps from the repository root.

1. Measure the working tree:

   ```bash
   crap-check
   ```

   The output shows the totals for source and for tests, the totals per
   workspace, and the ten worst functions.

2. Build the weekly history:

   ```bash
   crap-check history
   ```

   The first run measures every week since the first commit. Later runs
   measure only the new weeks.

3. Draw the charts:

   ```bash
   crap-check chart
   crap-check chart --metric cognitive
   ```

   The command writes `.complexity/history.svg` and
   `.complexity/history-cognitive.svg`.

4. Write the GitHub workflows:

   ```bash
   crap-check init --pr-comment
   ```

5. Add `.complexity` to `.prettierignore`, and add
   `.complexity/snapshot.json` to `.gitignore`.

6. Commit `crap-check.config.json`, `.github/workflows/` and `.complexity/`.

## Set up GitHub Actions

`init` writes two workflow files:

| File                                       | Runs on                 | Does                                                                       |
| ------------------------------------------ | ----------------------- | -------------------------------------------------------------------------- |
| `.github/workflows/crap-check-history.yml` | Schedule, manual run    | Runs `crap-check refresh` and commits `.complexity/`.                      |
| `.github/workflows/crap-check-pr.yml`      | Pull request (optional) | Runs `crap-check diff` from the merge base and posts or updates a comment. |

`init` also writes `crap-check.config.json` when that file is absent.

### Choose a schedule

| Option              | Cron        | Runs                       |
| ------------------- | ----------- | -------------------------- |
| `--cadence weekly`  | `0 6 * * 1` | Monday 06:00 UTC. Default. |
| `--cadence daily`   | `0 6 * * *` | Every day 06:00 UTC.       |
| `--cadence monthly` | `0 6 1 * *` | The 1st, 06:00 UTC.        |
| `--cron "<expr>"`   | Your value  | Any five-field cron.       |

GitHub runs schedules in UTC, and a scheduled run can start late when load is
high[^1^]. The history always has one row per ISO week. A daily run updates the
row of the current week. Each workflow also accepts a manual run from the
Actions tab (`workflow_dispatch`).

### Choose how results are saved

**Push mode** (`--mode push`, the default) commits to the target branch with
`[skip ci]` in the message. When another commit arrives during the run, the job
fetches the new tip, measures again, and tries again. It makes three attempts.
Use push mode when the workflow token can push to the branch.

> [!WARNING]
> Branch protection that requires a pull request or status checks blocks push
> mode. Use PR mode for a protected branch.

**PR mode** (`--mode pr`) pushes the branch `crap-check/refresh` and opens a pull
request into the target branch. When that pull request is already open, the
job updates its branch and does not open another one. Each run rebuilds the bot
branch from the target branch and force-pushes it.

> [!IMPORTANT]
> PR mode needs one repository setting. Go to Settings, then Actions, then
> General. Enable "Allow GitHub Actions to create and approve pull
> requests"[^2^]. Without the setting, `gh pr create` fails.

A pull request that `GITHUB_TOKEN` opens does not start other workflows[^15^].
CI checks therefore do not run on the bot pull request by themselves. Close and
open it again, or push to it, to start them.

### Choose the branch and the ref

`--branch` is the branch the workflow checks out and writes to. `--ref` is the
ref that `history` walks. Both default to the default branch of the remote,
read from `origin/HEAD`. The ref becomes `origin/<branch>`.

The two can differ. For example, write to `staging` and chart `origin/main`:

```bash
crap-check init --branch staging --ref origin/main
```

### Add the pull-request comment

`--pr-comment` also writes `crap-check-pr.yml`. On each pull request, the job:

1. Checks out the head commit with the full history.
2. Finds the merge base with the target branch.
3. Runs `crap-check diff` from the merge base to the head.
4. Adds the report to the job summary.
5. Finds its earlier comment by the marker `<!-- crap-check-report -->`. It
   updates that comment, or posts a new one.

The job skips pull requests from forks and from Dependabot, because their
tokens cannot write comments.

### Add coverage to the scheduled run

```bash
crap-check init --coverage "npx vitest run --coverage --coverage.reporter=lcov"
```

`--coverage` adds one coverage command to the new config. When the config has a
coverage command, the workflow installs dependencies before the run, and
`refresh` also runs `coverage` and `crap`. `init` reads the lockfile to pick the
install command:

| Lockfile                  | Install step                                         |
| ------------------------- | ---------------------------------------------------- |
| `bun.lock`, `bun.lockb`   | `oven-sh/setup-bun`, `bun install --frozen-lockfile` |
| `pnpm-lock.yaml`          | `corepack enable`, `pnpm install --frozen-lockfile`  |
| `yarn.lock`               | `corepack enable`, `yarn install --immutable`        |
| `package-lock.json`, none | `npm ci`                                             |

`--coverage` only works when there is no config yet. With an existing config,
add the command to the `coverage` key.

### Permissions and pinning

Each workflow sets `permissions: {}` at the top and gives each job only what it
needs[^3^]:

| Workflow          | Permissions                               |
| ----------------- | ----------------------------------------- |
| History, push     | `contents: write`                         |
| History, PR mode  | `contents: write`, `pull-requests: write` |
| Pull-request diff | `contents: read`, `pull-requests: write`  |

Each action is pinned to a full commit SHA, with the version in a comment. The
CLI is pinned to the version that wrote the file, for example
`npx -y crap-check@0.1.0`. An upgrade is therefore your decision. To
upgrade, run the new version with `--force`:

```bash
npx crap-check@latest init --force --pr-comment
```

`--force` writes the workflows again and keeps the config.

### All `init` options

| Option                             | Default                   | Meaning                                                      |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `--cadence weekly\|daily\|monthly` | `weekly`                  | Preset schedule.                                             |
| `--cron "<expr>"`                  |                           | Custom schedule. Use it in place of `--cadence`, never both. |
| `--mode push\|pr`                  | `push`                    | How the history workflow saves results.                      |
| `--branch <name>`                  | Remote default branch     | Branch to check out and write to.                            |
| `--ref <ref>`                      | `origin/<default branch>` | Ref that `history` walks.                                    |
| `--pr-comment`                     | Off                       | Also write the pull-request workflow.                        |
| `--coverage "<command>"`           |                           | Coverage command for a new config.                           |
| `--force`                          | Off                       | Write over existing workflow files.                          |

## Commands

```text
crap-check [measure] [--json] [--top N] [--write]
crap-check history   [--ref R] [--since YYYY-Www] [--rebuild]
crap-check chart     [--metric cyclomatic|cognitive] [--out path]
crap-check diff      --base B [--head H] [--markdown file] [--json file]
crap-check coverage  [--only cwd,cwd]
crap-check crap      [--top N] [--no-history] [--stale]
crap-check refresh   [--ref R] [--rebuild]
crap-check init      [options]
crap-check --help | --version
```

Run each command from inside the repository. The tool finds the repository
root from git, so a subdirectory also works. On a user error, the tool prints
`crap-check: <message>` and exits with code 1.

### `measure`

Measures the tracked files in the working tree. This is the default command.

| Option    | Default | Meaning                                                |
| --------- | ------- | ------------------------------------------------------ |
| `--top N` | 10      | Number of worst functions to print. The maximum is 50. |
| `--json`  | Off     | Print the snapshot as JSON on stdout.                  |
| `--write` | Off     | Also write `<outDir>/snapshot.json`.                   |

Uncommitted edits to tracked files are measured. Untracked files are not.

### `history`

Writes `history.json` and `history-by-workspace.json`. Each row is one ISO week.

| Option             | Default               | Meaning                                                 |
| ------------------ | --------------------- | ------------------------------------------------------- |
| `--ref R`          | Config, then detected | The ref to walk.                                        |
| `--since 2026-W01` | All weeks             | Skip weeks before this one.                             |
| `--rebuild`        | Off                   | Ignore the existing files and measure every week again. |

When `--ref` and the config `ref` are both absent, the tool uses the first ref
that exists from this list: `origin/HEAD`, `origin/main`, `origin/master`,
`HEAD`.

### `chart`

Reads the two history files and writes one SVG. The chart shows the repository
total at the top and the six largest workspaces below it. Dashed lines mark the
config `events`.

| Option                           | Default                                           | Meaning               |
| -------------------------------- | ------------------------------------------------- | --------------------- |
| `--metric cyclomatic\|cognitive` | `cyclomatic`                                      | Which series to draw. |
| `--out path`                     | `<outDir>/history.svg` or `history-cognitive.svg` | Where to write.       |

The chart needs two weeks or more. With fewer, the command skips the chart and
tells you. The SVG has no script and no external reference, so GitHub renders
it in a README.

### `diff`

Measures two commits and reports the change.

| Option            | Default | Meaning                               |
| ----------------- | ------- | ------------------------------------- |
| `--base B`        |         | Required. The commit to compare from. |
| `--head H`        | `HEAD`  | The commit to compare to.             |
| `--markdown file` | stdout  | Write the Markdown report to a file.  |
| `--json file`     |         | Also write the raw diff as JSON.      |

To see only what a branch adds, use the merge base as the base:

```bash
crap-check diff --base "$(git merge-base origin/main HEAD)"
```

The report contains these parts:

- The source totals of the base and the head, with the change.
- The counts over the thresholds: `over10`, `over20`, `over50` and `cogOver15`.
- The test totals.
- The ten changed files with the largest change.
- The ten functions that got worse and now score above 10.

Renamed files are followed, so a move does not show as a delete and an add.

### `coverage`

Runs each configured coverage command and records the result in
`.git/crap-check/coverage-manifest.json`. That file stays out of commits.

| Option           | Default      | Meaning                                        |
| ---------------- | ------------ | ---------------------------------------------- |
| `--only cwd,cwd` | All commands | Run only the commands with these `cwd` values. |

The command deletes each old lcov file before it runs, so an old report cannot
pass as a new one. A command that fails does not stop the run. Each run gets
one status: `ok`, `failed` or `no-lcov`. The command exits 0 in each case, and
`crap` reports the gaps.

### `crap`

Joins the last coverage run to the cyclomatic score of each function. It writes
`crap.json`, and it adds a row to `crap-history.json`.

| Option         | Default | Meaning                                                   |
| -------------- | ------- | --------------------------------------------------------- |
| `--top N`      | 10      | Number of worst functions to print. `crap.json` keeps 50. |
| `--no-history` | Off     | Do not write `crap-history.json`.                         |
| `--stale`      | Off     | Score coverage from another commit.                       |

> [!CAUTION]
> Coverage joins to functions by line number. Coverage from another commit can
> put the hits of one function on a different function. For that reason, `crap`
> stops when the coverage commit is not `HEAD`. Use `--stale` only when you
> know the lines did not move.

When a measured file has uncommitted edits, `crap` prints a warning and
continues. A run with `--only` writes no history row, because a subset would
read as a drop in the repository total.

### `refresh`

Runs the full update in this order:

1. `history`
2. `chart` for cyclomatic, then for cognitive
3. `coverage` and `crap`, only when the config has coverage commands

| Option      | Meaning                          |
| ----------- | -------------------------------- |
| `--ref R`   | Passed to `history` and `chart`. |
| `--rebuild` | Passed to `history`.             |

The generated workflow calls `refresh`.

### `init`

See [All `init` options](#all-init-options).

## Configuration

`crap-check.config.json` at the repository root. The file is optional, and each
key is optional. An unknown key is an error, so a misspelt key cannot fail
without a message.

```json
{
  "$schema": "https://unpkg.com/crap-check/crap-check.schema.json",
  "outDir": ".complexity",
  "ref": "origin/main",
  "extensions": [".ts", ".tsx"],
  "exclude": ["**/schema.ts", "scripts/legacy/**"],
  "workspaces": ["apps/*", "packages/*"],
  "events": [{ "week": "2026-W10", "label": "v2 launch" }],
  "coverage": [
    {
      "cwd": ".",
      "command": "bun test --coverage --coverage-reporter=lcov",
      "lcov": "coverage/lcov.info"
    }
  ]
}
```

The `$schema` key gives completion and validation in editors that read JSON
Schema.

| Key          | Type                     | Default                                 | Meaning                                                   |
| ------------ | ------------------------ | --------------------------------------- | --------------------------------------------------------- |
| `outDir`     | string                   | `.complexity`                           | Output directory, relative to the root.                   |
| `ref`        | string or null           | `null` (detected)                       | The ref `history` walks.                                  |
| `extensions` | string[]                 | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | File extensions to measure.                               |
| `exclude`    | glob[]                   | `[]`                                    | Paths to skip. Added to the default excludes.             |
| `test`       | glob[]                   | See below                               | Paths that are tests. Replaces the default list.          |
| `workspaces` | glob[] or null           | `null` (detected)                       | Workspace directories.                                    |
| `events`     | `{week, label}[]`        | `[]`                                    | Markers on the charts. `week` is an ISO week, `2026-W10`. |
| `coverage`   | `{cwd, command, lcov}[]` | `[]`                                    | Coverage commands. An empty list turns CRAP off.          |

### Which files are measured

The tool reads only files that git tracks, so `.gitignore` applies. A file is
measured when it has a configured extension and no exclude matches it. The
default excludes are:

```text
**/node_modules/**    **/dist/**         **/coverage/**
**/vendor/**          **/generated/**    **/__generated__/**
**/*.d.{ts,mts,cts}   **/*.min.js
{build,out}/**   */{build,out}/**   */*/{build,out}/**
```

`build` and `out` match only up to two levels below the root, as in `build/`,
`pkg/build/` and `apps/web/build/`. Deeper in a tree, these names are often
source folders, such as `src/order/build/`.

### Which files are tests

Tests are measured and reported apart from source, so a week of new tests does
not read as more complex source. The default test globs are:

```text
**/*{.,_}{test,spec}.*   **/__tests__/**   **/__mocks__/**
**/__fixtures__/**       **/test/**        **/tests/**
```

A `test` key replaces the whole list.

### Workspaces

Workspace totals sum to the repository total.

- With `workspaces` set, a file belongs to the first glob that matches a
  leading part of its path. For example, with `packages/*`, the file
  `packages/ui/src/button.tsx` belongs to `packages/ui`.
- With `workspaces` null, a file belongs to the nearest parent directory that
  holds a tracked `package.json`. The root `package.json` does not count.
- A file with no workspace belongs to `<root>`.

Detection reads each historical commit, so a package that moved has the
correct workspace in each week.

### Glob syntax

| Pattern | Matches                             |
| ------- | ----------------------------------- |
| `*`     | Any characters in one path segment. |
| `**`    | Any number of segments, also none.  |
| `?`     | One character, not `/`.             |
| `{a,b}` | Either alternative.                 |

A pattern matches the full path from the root. `dist/**` matches only the
top-level `dist`. `**/dist/**` matches a `dist` at any depth.

## Coverage and the CRAP score

The CRAP score needs line coverage in lcov format. Any runner that writes lcov
works. Each entry of `coverage` has three fields:

| Field     | Default              | Meaning                                            |
| --------- | -------------------- | -------------------------------------------------- |
| `cwd`     | `.`                  | Directory to run in, relative to the root.         |
| `command` |                      | Shell command that runs the tests and writes lcov. |
| `lcov`    | `coverage/lcov.info` | Path of the lcov file, relative to `cwd`.          |

The tool resolves `SF:` paths in the lcov file against `cwd`. One command
covers each workspace at or below its `cwd`, so one command at `.` covers the
whole repository.

Examples for common runners follow. Each one writes `coverage/lcov.info`. Check
the flags against the documentation of your runner version.

```jsonc
// Bun
{ "command": "bun test --coverage --coverage-reporter=lcov" }
// Vitest (needs @vitest/coverage-v8 or @vitest/coverage-istanbul)
{ "command": "npx vitest run --coverage --coverage.reporter=lcov" }
// Jest
{ "command": "npx jest --coverage --coverageReporters=lcov" }
// Node test runner with c8
{ "command": "npx c8 --reporter=lcovonly node --test" }
```

A monorepo can run one command per package:

```json
{
  "coverage": [
    {
      "cwd": "apps/api",
      "command": "bun test --coverage --coverage-reporter=lcov"
    },
    {
      "cwd": "apps/web",
      "command": "npx vitest run --coverage --coverage.reporter=lcov"
    }
  ]
}
```

Run the two steps in order:

```bash
crap-check coverage
crap-check crap
```

### Three coverage groups

`crap.json` keeps three groups of functions apart:

1. **Covered.** An lcov report lists the file. The function is scored on its
   line hits. The file decides, not the workspace. A shared package with no
   tests of its own gets the hits from the suites that import it.
2. **Unimported.** A coverage command for the workspace ran, and no report
   lists the file. No test loaded the file, so the function scores `U = 1`.
3. **Unmeasured.** No coverage command for the workspace succeeded. The tool
   has no data, so the function gets no score and stays out of each total.
   `coverage.unmeasured` gives the reason for each workspace.

The reasons for the unmeasured group are:

- `coverage command in <cwd> exited <code>`
- `coverage command wrote no lcov report`
- `no coverage command covers this workspace`

## The metrics

| Metric     | Definition                    | Flagged at                     |
| ---------- | ----------------------------- | ------------------------------ |
| Cyclomatic | ESLint `complexity` rule[^4^] | `over10`, `over20`, `over50`   |
| Cognitive  | Sonar whitepaper v1.7[^5^]    | `cogOver15`                    |
| CRAP       | NDepend rule ND1609[^6^]      | Above 30, longer than 10 lines |

### Cyclomatic complexity

Cyclomatic complexity counts the decision points in a function[^7^]. It is a
proxy for the number of paths a reader must follow, and for the number of tests
that cover the function.

The definition matches the ESLint `complexity` rule node for node[^4^]. A test
in this package runs ESLint `10.11.0` on the same fixtures and fails on any
difference. The snapshot records the oracle as `eslint@10.11.0 complexity`.

A unit starts at 1. These are units:

- function declarations, function expressions and arrow functions
- methods, constructors, getters and setters
- class field initializers that have a value
- class static blocks

A signature with no body is not a unit. Overloads, abstract members and
ambient declarations are in this group.

Each of these adds 1 to the innermost unit:

- `if`, `for`, `for...in`, `for...of`, `while`, `do`, `case`, `catch`
- the ternary, `&&`, `||`, `??`, `&&=`, `||=`, `??=`
- each link of an optional chain (`a?.b?.c` adds 2)
- each default value, on a parameter or in a destructuring pattern

`default:` and `try` add nothing. A decision point outside all functions goes
to the `moduleComplexity` of the file. The file total includes it.

The number differs from SonarQube. Sonar also counts `throw`. Sonar does not
count `??`, optional chains, logical assignment or default values.

Cyclomatic complexity has known limits. An exhaustive `switch` over a union
scores high and is easy to read. Four branches in a row and four nested
branches get the same score. Splitting a function of 40 into four functions of
10 leaves the total the same. Read `over10` and `over20` to act, and read the
total for the trend.

### Cognitive complexity

Cognitive complexity follows the Sonar whitepaper, Cognitive Complexity version
1.7, 29 August 2023, Appendix B[^5^]. It measures how hard code is to follow.

- Each break in the linear flow adds 1: `if`, the ternary, `switch`, the loops
  and `catch`.
- Each level of nesting around that break adds 1 more.
- `else if`, `else`, a labelled `break` or `continue`, and each sequence of
  the same logical operator add a flat 1.
- These add nothing: `try`, `finally`, `default:`, `??`, `?.`, logical
  assignment, default values, `return` and `throw`.
- A nested function raises the nesting level for its body.

A flat 30-case `switch` scores 31 cyclomatic and 1 cognitive.

The score of a unit includes the functions nested in it. The file total is the
sum of its top-level units plus the module scope, so totals add up across
files and workspaces.

These parts of the whitepaper are not implemented:

- The extra point for recursion. It needs a call graph across files, and the
  tool reads syntax only.
- The exception for declarative wrapper functions in Appendix A.

Where the SonarJS rule `S3776` differs from the whitepaper, the tool follows
the whitepaper.

### CRAP

CRAP (Change Risk Anti-Patterns) joins complexity and test coverage. Alberto
Savoia and Bob Evans proposed it in 2007[^8^][^9^]. This tool uses NDepend rule
ND1609[^6^][^10^]:

```text
CRAP(f) = CC(f)^2 * U(f)^3 + CC(f)
```

`CC` is the cyclomatic score of the function. `U` is the fraction of its lines
that no test ran, from 0 to 1.

- A function above 30 is flagged.
- A function of 10 lines or fewer is counted as `short` and gets no score.
- At full coverage, the score is `CC`.
- At no coverage, the score is `CC^2 + CC`. A function of 15 scores 240.
- Above `CC` 30, no amount of coverage gets a function under 30. Split it.

| Cyclomatic | Coverage needed to stay at 30 or below |
| ---------- | -------------------------------------- |
| 5          | 0%                                     |
| 10         | 42%                                    |
| 15         | 60%                                    |
| 25         | 80%                                    |
| 30         | 100%                                   |

The score has limits:

- Coverage comes from `DA:` line records[^11^]. The line range of a function
  includes its nested functions, so a parent gets the coverage of its
  callbacks.
- Line coverage is not branch coverage. A line that ran counts as covered when
  only one side of its condition ran. A low score is therefore optimistic.

## How the history works

1. `git log --first-parent` lists the commits of the ref. git formats the ISO
   week of each commit (`%G-W%V`) in UTC[^12^].
2. The newest commit of each week represents that week. A week with commits
   only on a merged side branch has no row.
3. For each week, `git ls-tree` lists the files, and `git cat-file --batch`
   reads the file contents from the object database[^13^]. Nothing is checked
   out.
4. Results are cached by blob ID and extension. A file that did not change is
   parsed once in the run.
5. The tool keeps the weeks that are already in the files, and measures only
   the missing weeks. It always measures the newest week again.

On a monorepo with about 3,000 files and 140 weeks, a full rebuild takes about
10 seconds, and an incremental run takes about 1 second.

When a history file has an older schema version, `history` rebuilds it and
prints a message. `crap-history.json` cannot be rebuilt, because coverage
cannot be computed for old commits. Each scheduled run adds one row.

## Output files

All files go in `outDir`, `.complexity` by default. The JSON uses a two-space
indent and a final newline, so a run that changes nothing writes no diff.

| File                        | Written by        | Commit it | Holds                                              |
| --------------------------- | ----------------- | --------- | -------------------------------------------------- |
| `history.json`              | `history`         | Yes       | One row per week: totals for source and for tests. |
| `history-by-workspace.json` | `history`         | Yes       | The same weeks, as flat maps per workspace.        |
| `history.svg`               | `chart`           | Yes       | Cyclomatic chart.                                  |
| `history-cognitive.svg`     | `chart`           | Yes       | Cognitive chart.                                   |
| `crap.json`                 | `crap`            | Yes       | The current CRAP state and the 50 worst functions. |
| `crap-history.json`         | `crap`            | Yes       | One CRAP row per week.                             |
| `snapshot.json`             | `measure --write` | No        | The current totals and the 50 worst functions.     |

Do not commit `snapshot.json`. It holds the time and the commit of each run, so
two branches always conflict on it.

### `Totals`

`history.json`, `snapshot.json` and the workspace entries use this shape:

| Field                        | Meaning                                             |
| ---------------------------- | --------------------------------------------------- |
| `files`                      | Measured files.                                     |
| `functions`                  | Units. A getter and a class field count.            |
| `complexity`                 | Sum of each unit plus module-scope decision points. |
| `lines`                      | Lines in the measured files.                        |
| `avgPerFunction`             | `complexity / functions`, 2 decimals.               |
| `maxFunction`                | Highest cyclomatic score of one unit.               |
| `over10`, `over20`, `over50` | Units above each cyclomatic threshold.              |
| `cognitive`                  | Sum of the cognitive scores of the files.           |
| `cognitiveMaxFunction`       | Highest cognitive score of one top-level unit.      |
| `cogOver15`                  | Units above cognitive 15.                           |

### `history.json`

```json
{
  "schemaVersion": 4,
  "weeks": [
    {
      "week": "2026-W10",
      "date": "2026-03-06T14:02:11+00:00",
      "commit": "<sha>",
      "source": {},
      "test": {}
    }
  ]
}
```

`source` and `test` each hold a `Totals`. Weeks are oldest first.

### `history-by-workspace.json`

Each week has four maps from workspace name to an integer: `source` and `test`
(cyclomatic), and `sourceCognitive` and `testCognitive`. The maps are flat to
keep the file short.

### `crap.json`

| Field                  | Meaning                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `schemaVersion`        | 2.                                                                              |
| `generatedAt`          | Time of the run.                                                                |
| `commit`, `ref`        | The commit that was scored.                                                     |
| `rule`                 | The formula and the threshold, in words.                                        |
| `partial`              | True when a coverage command failed or `--only` was used.                       |
| `coverage.measured`    | The `cwd` of each command that passed and wrote a report.                       |
| `coverage.unmeasured`  | `{workspace, reason}` for each workspace with unmeasured functions.             |
| `totals`, `workspaces` | `scored`, `unmeasured`, `short`, `over30`, `untested`, `total`, `avg`, `worst`. |
| `worst`                | The 50 worst functions: path, name, lines, scores, `uncovered`, `crap`.         |

`crap-history.json` holds one row per week: `week`, `date`, `commit`,
`partial` and `totals`.

## Troubleshooting

**`history` shows few weeks in CI.** The checkout is shallow. Set
`fetch-depth: 0` on `actions/checkout`. The generated workflows do this.

**`history` uses the wrong branch.** Set `ref` in the config, or pass `--ref`.
Without them, the tool uses `origin/HEAD` first.

**`crap` stops with a stale-coverage error.** The coverage came from another
commit. Run `crap-check coverage` again on the current commit.

**A workspace is in `coverage.unmeasured`.** Read its reason. Usually the
command failed, the `lcov` path is wrong, or no command has a `cwd` above the
workspace.

**Every function reads as untested.** The `SF:` paths in the lcov file do not
resolve against `cwd`. Open the lcov file and check that `cwd` plus the `SF:`
path gives the source file.

**The chart is missing.** It needs two weeks or more of history.

**`Schema mismatch` from `chart`.** The two history files come from different
versions. Run `crap-check history --rebuild`.

**The push fails in the history workflow.** Branch protection blocks the push.
Use `--mode pr`, or let the workflow push to the branch.

**`gh pr create` fails in PR mode.** Enable "Allow GitHub Actions to create and
approve pull requests". See
[Choose how results are saved](#choose-how-results-are-saved).

**The formatter changes `.complexity/`.** Add the directory to
`.prettierignore`.

## Development

```bash
bun install
bun test             # unit, fixture and end-to-end tests
bun run typecheck
bun run format
bun run build        # writes dist/cli.js for Node
node dist/cli.js --help
```

The tests make temporary git repositories, so they do not depend on the
history of this repository.

To compare the cyclomatic count with ESLint on a real repository, set these
variables:

| Variable                   | Meaning                              |
| -------------------------- | ------------------------------------ |
| `CRAP_CHECK_ORACLE_REPO`   | Path to the repository to sample.    |
| `CRAP_CHECK_ORACLE_SAMPLE` | Number of files to sample. Optional. |

```bash
CRAP_CHECK_ORACLE_REPO=/path/to/repo bun test test/oracle.spec.ts
```

### Release

Publishing to npm is manual:

```bash
npm login
npm version 0.2.0 -m "chore(release): 🔖 %s"
npm publish --access public   # prepublishOnly runs the typecheck, tests and build
git push origin main v0.2.0
```

The `v*` tag starts `release.yml`. It waits until npm serves the version, then
installs that version from npm, measures this repository with it, and commits
`.complexity/` to `main`.

## References

- ESLint `complexity` rule[^4^].
- G. Ann Campbell, _Cognitive Complexity: a new way of measuring
  understandability_, SonarSource, version 1.7, 29 August 2023[^5^].
- NDepend rule ND1609, in the NDepend Rules Explorer[^6^], and the NDepend
  article on the CRAP metric[^10^].
- Alberto Savoia, "Pardon My French, But This Code Is C.R.A.P. (2)"[^8^], and
  "The Code C.R.A.P. Metric Hits the Fan: Introducing the crap4j Plug-in"[^9^].
- Cyclomatic complexity, after Thomas McCabe, 1976[^7^].
- The lcov tracefile format, in the `geninfo` manual[^11^].
- ISO week date[^12^].
- `git cat-file`[^13^].
- GitHub Actions events, triggers, repository settings and workflow syntax[^1^][^15^][^2^][^3^].

## License

MIT © 2026 BÆRSkin Tactical. See [LICENSE](LICENSE).

[^1^]: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows

[^2^]: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository

[^3^]: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions

[^4^]: https://eslint.org/docs/latest/rules/complexity

[^5^]: https://www.sonarsource.com/docs/CognitiveComplexity.pdf

[^6^]: https://www.ndepend.com/default-rules/NDepend-Rules-Explorer.html

[^7^]: https://en.wikipedia.org/wiki/Cyclomatic_complexity

[^8^]: https://www.artima.com/weblogs/viewpost.jsp?thread=210575

[^9^]: https://www.artima.com/weblogs/viewpost.jsp?thread=215899

[^10^]: https://blog.ndepend.com/crap-metric-thing-tells-risk-code/

[^11^]: https://manpages.debian.org/unstable/lcov/geninfo.1.en.html

[^12^]: https://en.wikipedia.org/wiki/ISO_week_date

[^13^]: https://git-scm.com/docs/git-cat-file

[^15^]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
