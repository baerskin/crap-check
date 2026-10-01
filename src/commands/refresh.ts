import { parseArgs } from "node:util"
import { runChart } from "./chart"
import type { Context } from "./context"
import { runCoverage } from "./coverage"
import { runCrap } from "./crap"
import { runHistory } from "./history"

/**
 * Everything the scheduled workflow runs, in order: the history, both charts,
 * and the CRAP score when coverage commands are configured.
 *
 * The history and charts are a pure function of the walked ref. CRAP scores
 * the checked-out tree, so it describes the commit the workflow builds on.
 */
export const refreshCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: "string" },
      rebuild: { type: "boolean", default: false },
    },
  })

  await runHistory(context, { ref: values.ref, rebuild: values.rebuild })
  await runChart(context, { metric: "cyclomatic", ref: values.ref })
  await runChart(context, { metric: "cognitive", ref: values.ref })

  if (context.config.coverage.length === 0) {
    console.error("no coverage commands configured: CRAP skipped")
    return
  }

  await runCoverage(context, {})
  await runCrap(context, { top: 10, history: true, stale: false })
}
