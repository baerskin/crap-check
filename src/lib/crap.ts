import type { FileComplexity } from "./analyze"
import type { CoverageIndex, CoverageManifest } from "./lcov"

/**
 * Join complexity to coverage, the way NDepend rule ND1609 defines it.
 *
 * CRAP (Change Risk Anti-Patterns) is `CC^2 * U^3 + CC`, where `U` is the fraction
 * of the function no test executes. At full coverage it collapses to `CC`, so a
 * branchy function somebody tested scores as what it is. At no coverage it is
 * `CC^2 + CC`, so a function of 15 scores 240. The cube on `U` is what makes the
 * first few tests on an untested hot spot pay so much more than the last few.
 *
 * The thresholds fall out of the formula. A function at CC 10 needs 42% coverage to
 * stay under 30, at CC 25 it needs 80%, and past CC 30 no coverage brings it under.
 * That last one is the point the cyclomatic number alone cannot make.
 *
 * **An unmeasured function must never read as an uncovered one.** Three populations
 * stay apart here, and `CoverageState` is what keeps them apart. The score exists
 * only for the first two.
 */

/** ND1609's threshold. A scored function above it is what the rule flags. */
export const CRAP_THRESHOLD = 30

/**
 * ND1609 only flags a method longer than 10 lines. A 6-line function at CC 8 with
 * no test is noise, and the rule's authors say so, so short units are counted and
 * not scored.
 */
export const MIN_LINES = 10

/** Where a function's coverage number came from, or why it has none. */
export type CoverageState =
  /** The suite ran and the report lists the file. */
  | "covered"
  /** The suite ran and never imported the file. Genuinely untested. */
  | "unimported"
  /** No suite ran over this workspace. No score. */
  | "unmeasured"

/** One function, scored. */
export interface ScoredFunction {
  path: string
  workspace: string
  name: string
  line: number
  endLine: number
  complexity: number
  cognitive: number
  /** Fraction of the function's executable lines no test ran, 0 to 1, 4dp. */
  uncovered: number
  /** `CC^2 * U^3 + CC`, 2dp. */
  crap: number
}

/** One population of scored functions, summarised. */
export interface CrapTotals {
  /** Functions long enough to score, in a workspace a suite covered. */
  scored: number
  /** Functions in a workspace no suite covered. Excluded from every number below. */
  unmeasured: number
  /** Functions of 10 lines or fewer. ND1609 does not flag these. */
  short: number
  /** Scored functions above `CRAP_THRESHOLD`. */
  over30: number
  /** Scored functions a test never touched at all. */
  untested: number
  /** Sum of every scored function's CRAP. */
  total: number
  /** `total / scored`, 2dp. 0 when nothing scored. */
  avg: number
  worst: number
}

export const EMPTY_CRAP_TOTALS: CrapTotals = {
  scored: 0,
  unmeasured: 0,
  short: 0,
  over30: 0,
  untested: 0,
  total: 0,
  avg: 0,
  worst: 0,
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places

  return Math.round(value * factor) / factor
}

/** `CC^2 * U^3 + CC`. `uncovered` is a fraction, not a percentage. */
export const crapOf = (complexity: number, uncovered: number): number =>
  complexity ** 2 * uncovered ** 3 + complexity

/**
 * The fraction of `[line, endLine]` no test ran.
 *
 * Only lines lcov reports are counted. Bun emits a `DA:` record per executable
 * line, so a blank line, an import and a type declaration are all absent and none
 * of them dilutes the number. A range holding no `DA:` record at all is a function
 * with nothing to execute, which is covered by definition rather than untested.
 *
 * A nested function sits inside its parent's range, so a parent's number includes
 * its callbacks. Every line-based CRAP implementation behaves that way.
 */
export const uncoveredFraction = ({
  hits,
  line,
  endLine,
}: {
  hits: Map<number, number>
  line: number
  endLine: number
}): number => {
  let executable = 0
  let missed = 0

  for (let current = line; current <= endLine; current += 1) {
    const runs = hits.get(current)

    if (runs === undefined) {
      continue
    }

    executable += 1

    if (runs === 0) {
      missed += 1
    }
  }

  return executable === 0 ? 0 : missed / executable
}

/**
 * Does this run describe less than the whole repository?
 *
 * Two things make it partial: a suite that failed, and a `--only` flag that held
 * the coverage step to a subset. Both measure fewer functions than the week
 * before, and a reader who does not know that reads the drop as progress.
 */
export const isPartialRun = (manifest: CoverageManifest): boolean =>
  manifest.restricted || manifest.runs.some((run) => run.status !== "ok")

/** Does a run in `cwd` cover `workspace`? A root run covers every workspace. */
export const runCovers = (cwd: string, workspace: string): boolean =>
  cwd === "." || workspace === cwd || workspace.startsWith(`${cwd}/`)

/**
 * Why a workspace has no coverage, or `undefined` when an `ok` run covers it.
 *
 * A failed run outranks a missing one: when the root command failed, every
 * workspace reads as failed rather than as never configured.
 */
export const unmeasuredReason = (
  manifest: CoverageManifest,
  workspace: string
): string | undefined => {
  const runs = manifest.runs.filter((run) => runCovers(run.cwd, workspace))

  if (runs.some((run) => run.status === "ok")) {
    return undefined
  }

  const failed = runs.find((run) => run.status === "failed")

  if (failed !== undefined) {
    return `coverage command in ${failed.cwd} exited ${failed.exitCode}`
  }

  if (runs.length > 0) {
    return "coverage command wrote no lcov report"
  }

  return "no coverage command covers this workspace"
}

/** The units of one workspace that carry no score, by the reason they carry none. */
export interface SkippedUnits {
  unmeasured: number
  short: number
}

/** How one unit was classified, and its score when it has one. */
export interface UnitScore {
  state: CoverageState
  scored: ScoredFunction | null
}

/**
 * Score every unit of every file.
 *
 * `files` must be source files only. Scoring a spec against its own coverage says
 * nothing: a test file is covered by construction.
 *
 * `skipped` carries the two populations the scored list cannot: a workspace nobody
 * covered contributes no scores, so without it that workspace reads as having no
 * functions at all.
 */
export const scoreFiles = ({
  files,
  coverage,
  manifest,
}: {
  files: FileComplexity[]
  coverage: CoverageIndex
  manifest: CoverageManifest
}): {
  scores: ScoredFunction[]
  totals: CrapTotals
  skipped: Map<string, SkippedUnits>
} => {
  const scores: ScoredFunction[] = []
  const totals = { ...EMPTY_CRAP_TOTALS }
  const skipped = new Map<string, SkippedUnits>()

  for (const file of files) {
    const hits = coverage.get(file.path)

    const bucket = skipped.get(file.workspace) ?? { unmeasured: 0, short: 0 }
    skipped.set(file.workspace, bucket)

    // A shared package is imported by suites that live elsewhere, so its files can
    // carry real hits while it owns no suite of its own. Coverage in hand beats the
    // workspace's own run: only a file with neither is genuinely unmeasured.
    const isUnmeasured =
      hits === undefined &&
      unmeasuredReason(manifest, file.workspace) !== undefined

    for (const unit of file.units) {
      if (isUnmeasured) {
        totals.unmeasured += 1
        bucket.unmeasured += 1
        continue
      }

      if (unit.endLine - unit.line + 1 <= MIN_LINES) {
        totals.short += 1
        bucket.short += 1
        continue
      }

      // No entry for the file while its workspace's suite ran means nothing
      // imported it. Every line is uncovered, which is the honest reading.
      const uncovered =
        hits === undefined ? 1 : (
          uncoveredFraction({
            hits,
            line: unit.line,
            endLine: unit.endLine,
          })
        )

      const crap = crapOf(unit.complexity, uncovered)

      scores.push({
        path: file.path,
        workspace: file.workspace,
        name: unit.name,
        line: unit.line,
        endLine: unit.endLine,
        complexity: unit.complexity,
        cognitive: unit.cognitive,
        uncovered: round(uncovered, 4),
        crap: round(crap, 2),
      })

      totals.scored += 1
      totals.total += crap
      totals.worst = Math.max(totals.worst, crap)

      if (crap > CRAP_THRESHOLD) {
        totals.over30 += 1
      }

      if (uncovered === 1) {
        totals.untested += 1
      }
    }
  }

  totals.total = round(totals.total, 2)
  totals.worst = round(totals.worst, 2)
  totals.avg = totals.scored === 0 ? 0 : round(totals.total / totals.scored, 2)

  return {
    scores: scores.toSorted(
      (a, b) =>
        b.crap - a.crap || a.path.localeCompare(b.path) || a.line - b.line
    ),
    totals,
    skipped,
  }
}

/**
 * Re-summarise scores per workspace.
 *
 * `unmeasured` and `short` cannot be recovered from `scores`, because neither
 * population is in it, so they come from the file list the caller already has.
 */
export const crapByWorkspace = ({
  scores,
  skipped,
}: {
  scores: ScoredFunction[]
  skipped: Map<string, SkippedUnits>
}): Record<string, CrapTotals> => {
  const grouped = new Map<string, CrapTotals>()

  const bucketOf = (workspace: string): CrapTotals => {
    const existing = grouped.get(workspace)

    if (existing !== undefined) {
      return existing
    }

    const fresh = { ...EMPTY_CRAP_TOTALS }
    grouped.set(workspace, fresh)

    return fresh
  }

  for (const score of scores) {
    const bucket = bucketOf(score.workspace)

    bucket.scored += 1
    bucket.total += score.crap
    bucket.worst = Math.max(bucket.worst, score.crap)

    if (score.crap > CRAP_THRESHOLD) {
      bucket.over30 += 1
    }

    if (score.uncovered === 1) {
      bucket.untested += 1
    }
  }

  for (const [workspace, counts] of skipped) {
    const bucket = bucketOf(workspace)

    bucket.unmeasured = counts.unmeasured
    bucket.short = counts.short
  }

  for (const bucket of grouped.values()) {
    bucket.total = round(bucket.total, 2)
    bucket.worst = round(bucket.worst, 2)
    bucket.avg =
      bucket.scored === 0 ? 0 : round(bucket.total / bucket.scored, 2)
  }

  return Object.fromEntries(
    [...grouped.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  )
}
