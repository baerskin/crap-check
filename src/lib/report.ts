import {
  WORSENED_THRESHOLD,
  worsened,
  type Diff,
  type FileDelta,
  type Totals,
  type UnitDelta,
} from "./aggregate"

/**
 * Turns a base-against-head diff into the pull-request comment.
 *
 * Upserted, not appended: carries `MARKER` as an HTML marker the workflow
 * looks up. Keep `MARKER` first in the body, and update the lookup in the
 * pull-request workflow template if it changes.
 *
 * The headline is the source delta. The threshold counts sit under it because
 * they are the numbers a reviewer can act on: splitting one function of 40 into
 * four of 10 leaves the total alone and is still the right change.
 *
 * The functions-that-got-worse section is the NDepend article's baseline rule
 * for a codebase too large to refactor at once. Per-file totals cannot express
 * it: a function going 12 to 25 nets to zero inside a file that shed complexity
 * elsewhere.
 */

/** How the workflow recognises its own comment. */
export const MARKER = "<!-- crap-check-report -->"

/** How many changed files the comment names. Enough to see the cause. */
export const FILE_LIMIT = 10

/** How many worsened functions the comment names. */
export const UNIT_LIMIT = 10

const count = (value: number): string => value.toLocaleString("en-US")

const signed = (value: number): string =>
  value > 0 ? `+${count(value)}` : count(value)

const percent = (base: number, head: number): string => {
  if (base === 0) {
    return "new"
  }

  const change = ((head - base) / base) * 100

  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
}

const row = (
  label: string,
  base: number,
  head: number,
  bold = false
): string => {
  const delta = signed(head - base)

  return `| ${label} | ${count(base)} | ${count(head)} | ${bold ? `**${delta}**` : delta} |`
}

const fileRow = (file: FileDelta): string =>
  `| \`${file.path}\` | ${signed(file.delta)} | ${count(file.head)} | ${signed(file.cognitiveDelta)} | ${count(file.cognitiveHead)} |`

const verdict = (delta: number): string => {
  if (delta === 0) {
    return "no change"
  }

  return delta > 0 ? `+${count(delta)}` : count(delta)
}

// The total, the counts to act on, and the worst single function, for both
// metrics. Labels name the metric, since "over 10" alone is ambiguous. Over 50
// is the band the NDepend article calls untestable, so it earns a row even when
// it never moves.
const table = (base: Totals, head: Totals): string[] => [
  "|  | base | head | delta |",
  "| --- | ---: | ---: | ---: |",
  row("cyclomatic", base.complexity, head.complexity, true),
  row("functions", base.functions, head.functions),
  row("cyclomatic over 10", base.over10, head.over10),
  row("cyclomatic over 20", base.over20, head.over20),
  row("cyclomatic over 50", base.over50, head.over50),
  row("worst cyclomatic function", base.maxFunction, head.maxFunction),
  row("cognitive", base.cognitive, head.cognitive),
  row("cognitive over 15", base.cogOver15, head.cogOver15),
  row(
    "worst cognitive function",
    base.cognitiveMaxFunction,
    head.cognitiveMaxFunction
  ),
]

const unitRow = (unit: UnitDelta): string =>
  `| \`${unit.path}:${unit.line}\` \`${unit.name}\` | ${unit.base === 0 ? "new" : count(unit.base)} | ${count(unit.head)} | **${signed(unit.delta)}** |`

export const markdownReport = (diff: Diff, units: UnitDelta[] = []): string => {
  const { base, head } = diff.source
  const delta = head.complexity - base.complexity
  const changed = diff.files.filter((file) => !file.isTest)
  const testDelta = diff.test.head.complexity - diff.test.base.complexity

  const lines = [
    MARKER,
    `### Complexity ${verdict(delta)}`,
    "",
    `${count(base.complexity)} -> ${count(head.complexity)} (${percent(base.complexity, head.complexity)})`,
    "",
    ...table(base, head),
  ]

  if (changed.length > 0) {
    lines.push(
      "",
      `**Files with the largest change** (${changed.length} changed)`,
      "",
      "| file | cyclomatic delta | cyclomatic | cognitive delta | cognitive |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...changed.slice(0, FILE_LIMIT).map(fileRow)
    )
  }

  const worse = worsened(units)

  if (worse.length > 0) {
    lines.push(
      "",
      `**Functions that got worse** (${worse.length} above ${WORSENED_THRESHOLD})`,
      "",
      "| function | base | head | delta |",
      "| --- | ---: | ---: | ---: |",
      ...worse.slice(0, UNIT_LIMIT).map(unitRow)
    )
  }

  lines.push(
    "",
    `_Test files: ${signed(testDelta)}, counted apart._`,
    "",
    "<sub>Report only, nothing here can fail the build. Nothing is committed to this",
    "branch: the `.complexity/` series is rebuilt every Monday by the",
    "`complexity-history` workflow.</sub>"
  )

  return `${lines.join("\n")}\n`
}
