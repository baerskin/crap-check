import { join } from "node:path"
import { parseArgs } from "node:util"
import type { Totals } from "../lib/aggregate"
import { gitText } from "../lib/git"
import {
  buildSnapshot,
  HOTSPOT_LIMIT,
  measureWorkingTree,
  writeJson,
} from "../lib/measure"
import { positiveInt, type Context } from "./context"

/**
 * Measure the working tree and print a summary.
 *
 * `--json` prints the snapshot object. `--write` also stores it as
 * `snapshot.json` in the output directory; that file is meant to stay
 * uncommitted, because its commit and timestamp change on every run.
 */

const line = (label: string, totals: Totals): string =>
  [
    label.padEnd(8),
    `files=${totals.files}`.padEnd(12),
    `functions=${totals.functions}`.padEnd(17),
    `loc=${totals.lines}`.padEnd(13),
    `complexity=${totals.complexity}`.padEnd(19),
    `avg=${totals.avgPerFunction.toFixed(2)}`.padEnd(10),
    `max=${totals.maxFunction}`,
  ].join("")

export const measureCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      top: { type: "string" },
    },
  })
  const { root, config, ts, outDir } = context
  const files = await measureWorkingTree({ root, ts, config })

  const snapshot = buildSnapshot({
    files,
    commit: gitText(root, ["rev-parse", "HEAD"]),
    ref: gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    generatedAt: new Date().toISOString(),
  })

  if (values.write) {
    await writeJson(join(outDir, "snapshot.json"), snapshot)
    console.error(`wrote ${join(config.outDir, "snapshot.json")}`)
  }

  if (values.json) {
    console.log(JSON.stringify(snapshot))
    return
  }

  console.log(line("source", snapshot.source))
  console.log(line("test", snapshot.test))
  console.log(
    `\nover10=${snapshot.source.over10}  over20=${snapshot.source.over20}  over50=${snapshot.source.over50}`
  )
  console.log(
    `cognitive=${snapshot.source.cognitive}  over15=${snapshot.source.cogOver15}  max=${snapshot.source.cognitiveMaxFunction}`
  )

  console.log("\nby workspace (source)")

  for (const [workspace, totals] of Object.entries(
    snapshot.workspaces
  ).toSorted(([, a], [, b]) => b.complexity - a.complexity)) {
    console.log(
      `  ${workspace.padEnd(28)}${String(totals.complexity).padStart(7)}`
    )
  }

  const top = Math.min(positiveInt(values.top, 10), HOTSPOT_LIMIT)

  console.log(`\nworst functions (top ${top}, by cyclomatic)`)
  console.log("  cyc   cog   where")

  for (const spot of snapshot.hotspots.slice(0, top)) {
    console.log(
      `  ${String(spot.complexity).padStart(4)}  ${String(spot.cognitive).padStart(4)}  ${spot.path}:${spot.line}  ${spot.name}`
    )
  }
}
