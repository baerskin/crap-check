import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { diffOf, unitDiffOf } from "../lib/aggregate"
import { git } from "../lib/git"
import { listTree } from "../lib/gitTree"
import {
  changedPaths,
  measureCommit,
  readUnits,
  type BlobCache,
} from "../lib/history"
import { createScope } from "../lib/include"
import { markdownReport } from "../lib/report"
import { UsageError, type Context } from "./context"

/**
 * Report what a branch does to the complexity of the codebase.
 *
 * Both sides are read from the object database, so one working tree is enough.
 * Pass the merge base as `--base` to show what the branch added rather than
 * what the target branch picked up meanwhile. Exits 0 whatever the numbers say.
 */

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

export const diffCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      markdown: { type: "string" },
      json: { type: "string" },
    },
  })

  if (values.base === undefined) {
    throw new UsageError("--base <rev> is required.")
  }

  const { root, config, ts } = context
  const { base: baseRev, head: headRev } = values

  // One cache for both sides: a file the branch did not touch is the same blob
  // on each, so it is read and parsed once.
  const cache: BlobCache = new Map()
  const base = await measureCommit({ root, commit: baseRev, ts, cache, config })
  const head = await measureCommit({ root, commit: headRev, ts, cache, config })
  const diff = diffOf(base, head)

  // The paths git says the branch touched, not the paths whose totals moved:
  // a function going 12 to 25 beside one going 25 to 12 nets to zero. `-M`
  // keeps the link between the two halves of a rename.
  const scope = createScope(
    config,
    listTree(root, headRev).map((entry) => entry.path)
  )
  const changed = changedPaths(
    git(root, ["diff", "--name-status", "-M", "-z", baseRev, headRev]),
    scope
  )

  const baseUnits = await readUnits({
    root,
    commit: baseRev,
    paths: changed.base,
    ts,
    scope,
  })
  const headUnits = await readUnits({
    root,
    commit: headRev,
    paths: changed.head,
    ts,
    scope,
  })

  const units = unitDiffOf(
    // `unitDiffOf` pairs on path and name, so a base unit has to sit on the path
    // its file ends up at.
    baseUnits.map((sample) => ({
      ...sample,
      path: changed.renames.get(sample.path) ?? sample.path,
    })),
    headUnits
  )

  const markdown = markdownReport(diff, units)

  if (values.json !== undefined) {
    await write(
      resolve(root, values.json),
      `${JSON.stringify({ ...diff, units }, null, 2)}\n`
    )
  }

  if (values.markdown === undefined) {
    console.log(markdown)
    return
  }

  await write(resolve(root, values.markdown), markdown)
  console.error(`wrote ${values.markdown}`)
}
