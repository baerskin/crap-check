import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  crapByWorkspace,
  CRAP_THRESHOLD,
  isPartialRun,
  MIN_LINES,
  scoreFiles,
  unmeasuredReason,
  type CrapTotals,
  type ScoredFunction,
} from "../lib/crap"
import { gitText } from "../lib/git"
import { mergeWeeks } from "../lib/history"
import { loadCoverage, type CoverageManifest } from "../lib/lcov"
import {
  listMeasuredFiles,
  measureWorkingTree,
  readJson,
  sourceOf,
  writeJson,
} from "../lib/measure"
import { positiveInt, UsageError, type Context } from "./context"
import { manifestPath } from "./coverage"

/**
 * Score every function with CRAP, from the last `coverage` run.
 *
 * Writes `crap.json` with the current state and adds one row per ISO week to
 * `crap-history.json`. Coverage cannot be reconstructed for a past commit, so
 * unlike the complexity history this series can never be backfilled: a week
 * nobody scored stays missing.
 */

/** Bump when the meaning of any recorded number changes. */
const CRAP_SCHEMA_VERSION = 2

/** How many functions `crap.json` names. Enough to act on, short enough to read. */
const WORST_LIMIT = 50

export interface CrapReport {
  schemaVersion: number
  generatedAt: string
  commit: string
  ref: string
  /** What the score is and what flags a function, so the file explains itself. */
  rule: string
  /** True when a command failed or `--only` restricted the coverage run. */
  partial: boolean
  coverage: {
    /** Directories whose coverage command passed and wrote a report. */
    measured: string[]
    /** Workspaces holding functions nobody measured, with the reason. */
    unmeasured: { workspace: string; reason: string }[]
  }
  totals: CrapTotals
  workspaces: Record<string, CrapTotals>
  worst: ScoredFunction[]
}

interface CrapWeekRow {
  week: string
  date: string
  commit: string
  partial: boolean
  totals: CrapTotals
}

interface CrapHistory {
  schemaVersion: number
  weeks: CrapWeekRow[]
}

export const runCrap = async (
  context: Context,
  { top, history, stale }: { top: number; history: boolean; stale: boolean }
): Promise<void> => {
  const { root, config, ts, outDir } = context
  const path = manifestPath(root)

  if (!existsSync(path)) {
    throw new UsageError("No coverage manifest. Run: crap-check coverage")
  }

  const manifest = await readJson<CoverageManifest>(path)
  const head = gitText(root, ["rev-parse", "HEAD"])

  if (manifest.commit !== head && !stale) {
    throw new UsageError(
      [
        `Coverage was measured at ${manifest.commit.slice(0, 9)} and the tree is at ${head.slice(0, 9)}.`,
        "Line numbers move between commits, so the hits would land on the wrong functions.",
        "Run `crap-check coverage` again, or pass --stale to score anyway.",
      ].join("\n")
    )
  }

  const { scope } = listMeasuredFiles(root, config)

  // A commit match is not a content match: an edit after the run shifts the
  // lines under the hits without moving HEAD.
  const dirty = gitText(root, ["diff", "--name-only", "HEAD"])
    .split("\n")
    .filter((file) => file !== "" && scope.isMeasured(file))

  if (dirty.length > 0) {
    console.warn(
      `The tree changed since the coverage run (${dirty.length} measured files). Scores may not line up.`
    )
  }

  const files = sourceOf(await measureWorkingTree({ root, ts, config }))
  const coverage = await loadCoverage({
    manifest,
    repoRoot: root,
    isMeasured: scope.isMeasured,
  })
  const { scores, totals, skipped } = scoreFiles({ files, coverage, manifest })

  // Workspaces that hold functions nobody measured. A shared package covered
  // whole by the suites that import it has nothing unknown in it, so it is
  // not listed even when no command runs inside it.
  const unmeasured = [...skipped]
    .filter(([, counts]) => counts.unmeasured > 0)
    .map(([workspace]) => workspace)
    .toSorted()
    .map((workspace) => ({
      workspace,
      reason: unmeasuredReason(manifest, workspace) ?? "no coverage report",
    }))

  const report: CrapReport = {
    schemaVersion: CRAP_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    commit: head,
    ref: gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    rule: `NDepend ND1609: CRAP = CC^2 * U^3 + CC, flagged above ${CRAP_THRESHOLD} for a function longer than ${MIN_LINES} lines`,
    partial: isPartialRun(manifest),
    coverage: {
      measured: manifest.runs
        .filter((run) => run.status === "ok")
        .map((run) => run.cwd),
      unmeasured,
    },
    totals,
    workspaces: crapByWorkspace({ scores, skipped }),
    worst: scores.slice(0, WORST_LIMIT),
  }

  await writeJson(join(outDir, "crap.json"), report)

  // A subset must not replace the week's repository-wide row: `mergeWeeks`
  // overwrites by week, so missing coverage would read as a dip.
  if (history && manifest.restricted) {
    console.warn(
      "The coverage run was restricted to a subset, so crap-history.json is left alone."
    )
  }

  if (history && !manifest.restricted) {
    const historyPath = join(outDir, "crap-history.json")

    // Git formats the week key, the same way `weekPoints` does, so both series
    // key on one clock.
    const [week, date] = gitText(
      root,
      ["log", "-1", "--date=format-local:%G-W%V", "--format=%cd %cI"],
      { TZ: "UTC" }
    ).split(" ")

    if (week === undefined || date === undefined) {
      throw new Error("Could not read the commit week from git.")
    }

    const existing =
      existsSync(historyPath) ?
        await readJson<CrapHistory>(historyPath)
      : { schemaVersion: CRAP_SCHEMA_VERSION, weeks: [] }

    await writeJson(historyPath, {
      schemaVersion: CRAP_SCHEMA_VERSION,
      weeks: mergeWeeks(
        existing.schemaVersion === CRAP_SCHEMA_VERSION ? existing.weeks : [],
        [{ week, date, commit: head, partial: report.partial, totals }]
      ),
    } satisfies CrapHistory)
  }

  console.log(`crap (${report.ref} at ${report.commit.slice(0, 9)})`)
  console.log("=".repeat(40))
  console.log(`scored      ${totals.scored}`)
  console.log(`over ${CRAP_THRESHOLD}     ${totals.over30}`)
  console.log(`untested    ${totals.untested}`)
  console.log(`worst       ${totals.worst}`)
  console.log(`average     ${totals.avg}`)
  console.log(
    `short       ${totals.short} (${MIN_LINES} lines or fewer, not scored)`
  )
  console.log(
    `unmeasured  ${totals.unmeasured} in ${unmeasured.length} workspace(s)`
  )

  const shown = Math.min(top, WORST_LIMIT)

  console.log(`\nworst functions (top ${shown})`)
  console.log("  crap      cyc   unc   where")

  for (const score of report.worst.slice(0, shown)) {
    console.log(
      `  ${score.crap.toFixed(0).padStart(8)}  ${String(score.complexity).padStart(3)}  ` +
        `${`${Math.round(score.uncovered * 100)}%`.padStart(4)}  ` +
        `${score.path}:${score.line}  ${score.name}`
    )
  }

  console.log(`\nwrote ${join(config.outDir, "crap.json")}`)
}

export const crapCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    // `allowNegative` is what makes `--no-history` parse.
    allowNegative: true,
    options: {
      top: { type: "string" },
      history: { type: "boolean", default: true },
      stale: { type: "boolean", default: false },
    },
  })

  await runCrap(context, {
    top: positiveInt(values.top, 10),
    history: values.history,
    stale: values.stale,
  })
}
