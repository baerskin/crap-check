import type { FileAnalysis, FileComplexity, Unit } from "./analyze"

/**
 * Roll per-file measurements up into the numbers the artifacts and the pull-request
 * comment carry.
 *
 * `source` and `test` are aggregated separately, so a week of test writing never reads
 * as the codebase getting more complex.
 *
 * `over10`, `over20` and `over50` are the numbers to act on; the grand total is only a
 * trend line. Splitting one function of 40 into four of 10 leaves the total alone and
 * moves `over20` from 1 to 0, the improvement that actually happened.
 *
 * Cognitive complexity rides in the same fields as cyclomatic, since it answers whether
 * a high number comes from wide branching or branching nested inside other branches.
 */

/** The cyclomatic thresholds counted in every `Totals`, as strict upper bounds. */
export const THRESHOLDS = [10, 20, 50] as const

/**
 * The cognitive limit, as a strict upper bound. 15 is the default SonarQube
 * ships for every language, so a function over it is one Sonar would flag.
 */
export const COGNITIVE_THRESHOLD = 15

/**
 * One file reduced to the fixed-size numbers every roll-up needs.
 *
 * The weekly backfill measures 162,459 file versions and memoises on the git blob id.
 * This shape is bounded, unlike caching whole `FileComplexity` values (every
 * `units[]` array), so peak memory stays in the tens of MB.
 */
export interface FileSummary {
  path: string
  workspace: string
  isTest: boolean
  lines: number
  functions: number
  /** Units plus module-scope decision points, the number the artifacts carry. */
  complexity: number
  max: number
  over10: number
  over20: number
  over50: number
  /** Top-level units plus module scope. Nested units are already inside those. */
  cognitive: number
  /** The worst top-level unit. */
  cognitiveMax: number
  /** Top-level units over `COGNITIVE_THRESHOLD`. */
  cogOver15: number
}

/** The part of a summary that follows from the content alone, not from the path. */
export type BlobSummary = Omit<FileSummary, "path" | "workspace" | "isTest">

export const summarizeBlob = (file: FileAnalysis): BlobSummary => {
  const summary: BlobSummary = {
    lines: file.lines,
    functions: file.units.length,
    complexity: file.total,
    max: file.max,
    over10: 0,
    over20: 0,
    over50: 0,
    cognitive: file.cognitiveTotal,
    cognitiveMax: file.cognitiveMax,
    cogOver15: 0,
  }

  for (const unit of file.units) {
    for (const threshold of THRESHOLDS) {
      if (unit.complexity > threshold) {
        summary[`over${threshold}`] += 1
      }
    }

    // Top-level units only: a nested unit's score is already counted inside its owner's.
    if (unit.owner === -1 && unit.cognitive > COGNITIVE_THRESHOLD) {
      summary.cogOver15 += 1
    }
  }

  return summary
}

export const summarize = (file: FileComplexity): FileSummary => ({
  path: file.path,
  workspace: file.workspace,
  isTest: file.isTest,
  ...summarizeBlob(file),
})

/** One population of files, summarised. */
export interface Totals {
  files: number
  /** Units, not `function` keywords: a getter and a class field count. */
  functions: number
  /** Sum of every unit plus every file's module-scope decision points. */
  complexity: number
  lines: number
  /** `complexity / functions`, 2dp. 0 when there are no functions. */
  avgPerFunction: number
  maxFunction: number
  over10: number
  over20: number
  over50: number
  /** Sum of every file's cognitive score. */
  cognitive: number
  /** The worst single top-level unit. */
  cognitiveMaxFunction: number
  /** Units over `COGNITIVE_THRESHOLD`: the ones to act on. */
  cogOver15: number
}

/** One function worth naming in a report. */
export interface Hotspot {
  path: string
  name: string
  line: number
  complexity: number
  /**
   * The same unit's cognitive score. Far lower than `complexity` usually means a
   * flat `switch` or long guard chain, which reads better than the number suggests.
   */
  cognitive: number
}

export const EMPTY_TOTALS: Totals = {
  files: 0,
  functions: 0,
  complexity: 0,
  lines: 0,
  avgPerFunction: 0,
  maxFunction: 0,
  over10: 0,
  over20: 0,
  over50: 0,
  cognitive: 0,
  cognitiveMaxFunction: 0,
  cogOver15: 0,
}

const round2 = (value: number): number => Math.round(value * 100) / 100

export const totalsOf = (files: FileSummary[]): Totals => {
  const totals = { ...EMPTY_TOTALS, files: files.length }

  for (const file of files) {
    totals.complexity += file.complexity
    totals.lines += file.lines
    totals.functions += file.functions
    totals.maxFunction = Math.max(totals.maxFunction, file.max)
    totals.cognitive += file.cognitive
    totals.cognitiveMaxFunction = Math.max(
      totals.cognitiveMaxFunction,
      file.cognitiveMax
    )
    totals.cogOver15 += file.cogOver15

    for (const threshold of THRESHOLDS) {
      totals[`over${threshold}`] += file[`over${threshold}`]
    }
  }

  totals.avgPerFunction =
    totals.functions === 0 ? 0 : round2(totals.complexity / totals.functions)

  return totals
}

export const byWorkspace = (files: FileSummary[]): Record<string, Totals> => {
  const grouped = new Map<string, FileSummary[]>()

  for (const file of files) {
    const bucket = grouped.get(file.workspace)

    if (bucket === undefined) {
      grouped.set(file.workspace, [file])
    } else {
      bucket.push(file)
    }
  }

  return Object.fromEntries(
    [...grouped.entries()]
      .map(([workspace, bucket]): [string, Totals] => [
        workspace,
        totalsOf(bucket),
      ])
      .toSorted(([a], [b]) => a.localeCompare(b))
  )
}

/**
 * One integer per workspace, for the history series.
 *
 * One function for both metrics rather than two near-identical ones: the history file
 * stores a flat map per metric, since a nested object per workspace costs four lines
 * each once indented.
 */
export const byWorkspaceMetric = (
  files: FileSummary[],
  metric: "complexity" | "cognitive"
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(byWorkspace(files)).map(([workspace, totals]) => [
      workspace,
      totals[metric],
    ])
  )

/** The `n` worst units, worst first. Ties break on path then line, so it is stable. */
export const hotspots = (files: FileComplexity[], n: number): Hotspot[] =>
  files
    .flatMap((file) =>
      file.units.map((unit): Hotspot => ({
        path: file.path,
        name: unit.name,
        line: unit.line,
        complexity: unit.complexity,
        cognitive: unit.cognitive,
      }))
    )
    .toSorted(
      (a, b) =>
        b.complexity - a.complexity ||
        a.path.localeCompare(b.path) ||
        a.line - b.line
    )
    .slice(0, n)

/** One file's change between two commits, in both metrics. */
export interface FileDelta {
  path: string
  isTest: boolean
  base: number
  head: number
  delta: number
  cognitiveBase: number
  cognitiveHead: number
  cognitiveDelta: number
}

/** Base against head, for the pull-request comment. */
export interface Diff {
  source: { base: Totals; head: Totals }
  test: { base: Totals; head: Totals }
  /**
   * Only files where one metric moved, largest absolute cyclomatic change first.
   * Re-nesting without adding a branch moves cognitive alone, so a file is listed
   * when either number changed. A rename reads as one removal and one addition,
   * since the key is the path.
   */
  files: FileDelta[]
}

const totalByPath = (
  files: FileSummary[]
): Map<string, { total: number; cognitive: number; isTest: boolean }> =>
  new Map(
    files.map((file) => [
      file.path,
      {
        total: file.complexity,
        cognitive: file.cognitive,
        isTest: file.isTest,
      },
    ])
  )

const sideOf = (files: FileSummary[], isTest: boolean): FileSummary[] =>
  files.filter((file) => file.isTest === isTest)

export const diffOf = (base: FileSummary[], head: FileSummary[]): Diff => {
  const baseTotals = totalByPath(base)
  const headTotals = totalByPath(head)

  const files = [...new Set([...baseTotals.keys(), ...headTotals.keys()])]
    .map((path): FileDelta => {
      const before = baseTotals.get(path)
      const after = headTotals.get(path)

      return {
        path,
        // A deleted file keeps the classification it had on the base side.
        isTest: after?.isTest ?? before?.isTest ?? false,
        base: before?.total ?? 0,
        head: after?.total ?? 0,
        delta: (after?.total ?? 0) - (before?.total ?? 0),
        cognitiveBase: before?.cognitive ?? 0,
        cognitiveHead: after?.cognitive ?? 0,
        cognitiveDelta: (after?.cognitive ?? 0) - (before?.cognitive ?? 0),
      }
    })
    .filter((file) => file.delta !== 0 || file.cognitiveDelta !== 0)
    .toSorted(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path)
    )

  return {
    source: {
      base: totalsOf(sideOf(base, false)),
      head: totalsOf(sideOf(head, false)),
    },
    test: {
      base: totalsOf(sideOf(base, true)),
      head: totalsOf(sideOf(head, true)),
    },
    files,
  }
}

/** One file's units at one commit, for the per-function diff. */
export interface UnitSample {
  path: string
  isTest: boolean
  units: Unit[]
}

/** One function's change between two commits. */
export interface UnitDelta {
  path: string
  name: string
  /** The head line when the function still exists, the base line when it went. */
  line: number
  /** 0 when the function is new. */
  base: number
  /** 0 when the function was removed. */
  head: number
  delta: number
  cognitiveBase: number
  cognitiveHead: number
}

/**
 * The cyclomatic score above which a function that got worse is worth naming.
 *
 * The NDepend article's baseline rule: do not let an already-complex function get
 * more complex. 10 is the bound `over10` counts, so the threshold and the totals
 * agree about "complex".
 */
export const WORSENED_THRESHOLD = 10

const keyOf = (path: string, name: string): string => `${path}\u0000${name}`

/**
 * Index a side by path and name, keeping repeats in line order.
 *
 * A file full of `<anonymous>` arrows shares one name, so the occurrences pair by
 * position: a new arrow near the top shifts every later pairing, and a rename reads
 * as one removal and one addition. A syntax-only parse has nothing stabler to key on,
 * and the per-file diff carries the same limitation.
 */
const unitsByName = (samples: UnitSample[]): Map<string, Unit[]> => {
  const index = new Map<string, Unit[]>()

  for (const sample of samples) {
    for (const unit of sample.units.toSorted((a, b) => a.line - b.line)) {
      const key = keyOf(sample.path, unit.name)
      const bucket = index.get(key)

      if (bucket === undefined) {
        index.set(key, [unit])
      } else {
        bucket.push(unit)
      }
    }
  }

  return index
}

/**
 * Pair base units against head units, worst regression first.
 *
 * Only source files go in. A spec that grew a branch is not a regression.
 */
export const unitDiffOf = (
  base: UnitSample[],
  head: UnitSample[]
): UnitDelta[] => {
  const baseIndex = unitsByName(base.filter((sample) => !sample.isTest))
  const headIndex = unitsByName(head.filter((sample) => !sample.isTest))

  const deltas: UnitDelta[] = []

  for (const key of new Set([...baseIndex.keys(), ...headIndex.keys()])) {
    const [path = "", name = ""] = key.split("\u0000")
    const befores = baseIndex.get(key) ?? []
    const afters = headIndex.get(key) ?? []

    for (
      let index = 0;
      index < Math.max(befores.length, afters.length);
      index += 1
    ) {
      const before = befores[index]
      const after = afters[index]

      deltas.push({
        path,
        name,
        line: after?.line ?? before?.line ?? 0,
        base: before?.complexity ?? 0,
        head: after?.complexity ?? 0,
        delta: (after?.complexity ?? 0) - (before?.complexity ?? 0),
        cognitiveBase: before?.cognitive ?? 0,
        cognitiveHead: after?.cognitive ?? 0,
      })
    }
  }

  return deltas
    .filter((unit) => unit.delta !== 0)
    .toSorted(
      (a, b) =>
        b.delta - a.delta || a.path.localeCompare(b.path) || a.line - b.line
    )
}

/**
 * The functions the article's baseline rule says to catch: worse than before, and
 * now above `WORSENED_THRESHOLD`. A new function lands here too, because its base
 * is 0 and its delta is its whole score.
 */
export const worsened = (deltas: UnitDelta[]): UnitDelta[] =>
  deltas.filter((unit) => unit.delta > 0 && unit.head > WORSENED_THRESHOLD)
