import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import pkg from "../../package.json" with { type: "json" }
import { CONFIG_FILE, resolveRef } from "../lib/config"
import {
  renderHistoryWorkflow,
  renderPrWorkflow,
  type PackageManager,
  type WriteMode,
} from "../templates/workflows"
import { UsageError, type Context } from "./context"

/**
 * Write the config and the GitHub workflows into a repository.
 *
 * The workflows pin the CLI to the version that wrote them, so an upgrade is
 * a deliberate rerun of `init --force`, not a surprise on the next schedule.
 */

export const CADENCES = {
  weekly: "0 6 * * 1",
  daily: "0 6 * * *",
  monthly: "0 6 1 * *",
} as const

export const HISTORY_WORKFLOW = ".github/workflows/crap-check-history.yml"
export const PR_WORKFLOW = ".github/workflows/crap-check-pr.yml"

/** Five fields of digits, `*`, `/`, `,` and `-`. GitHub validates the rest. */
const CRON = /^(?:[\d*/,-]+\s+){4}[\d*/,-]+$/

/** Characters safe to drop into YAML and a shell line unquoted. */
const SAFE_REF = /^[\w./-]+$/

const LOCKFILES: [string, PackageManager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

export const detectPackageManager = (root: string): PackageManager =>
  LOCKFILES.find(([file]) => existsSync(join(root, file)))?.[1] ?? "npm"

export interface InitOptions {
  cron: string
  mode: WriteMode
  branch: string
  ref: string
  isPrComment: boolean
  coverage?: string
  isForced: boolean
}

const cronOf = (
  cadence: string | undefined,
  cron: string | undefined
): string => {
  if (cron !== undefined && cadence !== undefined) {
    throw new UsageError("Pass --cadence or --cron, not both.")
  }

  if (cron !== undefined) {
    if (!CRON.test(cron.trim())) {
      throw new UsageError(`--cron must be five cron fields, got "${cron}".`)
    }

    return cron.trim()
  }

  const key = cadence ?? "weekly"

  if (!Object.hasOwn(CADENCES, key)) {
    throw new UsageError(
      `--cadence must be one of ${Object.keys(CADENCES).join(", ")}.`
    )
  }

  return CADENCES[key as keyof typeof CADENCES]
}

const safeRef = (flag: string, value: string): string => {
  if (!SAFE_REF.test(value)) {
    throw new UsageError(
      `--${flag} holds characters a workflow cannot carry: "${value}".`
    )
  }

  return value
}

/** Parse `init` flags into options. Exported for the spec. */
export const parseInitArgs = (
  context: Pick<Context, "root" | "config">,
  argv: string[]
): InitOptions => {
  const { values } = parseArgs({
    args: argv,
    options: {
      cadence: { type: "string" },
      cron: { type: "string" },
      mode: { type: "string", default: "push" },
      branch: { type: "string" },
      ref: { type: "string" },
      "pr-comment": { type: "boolean", default: false },
      coverage: { type: "string" },
      force: { type: "boolean", default: false },
    },
  })

  if (values.mode !== "push" && values.mode !== "pr") {
    throw new UsageError("--mode must be push or pr.")
  }

  const ref = safeRef(
    "ref",
    values.ref ?? resolveRef(context.root, context.config)
  )
  const branch = safeRef(
    "branch",
    values.branch ??
      (ref.startsWith("origin/") ? ref.slice("origin/".length) : "main")
  )

  return {
    cron: cronOf(values.cadence, values.cron),
    mode: values.mode,
    branch,
    ref,
    isPrComment: values["pr-comment"],
    coverage: values.coverage,
    isForced: values.force,
  }
}

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

export const runInit = async (
  context: Pick<Context, "root" | "config">,
  options: InitOptions
): Promise<string[]> => {
  const { root, config } = context
  const configPath = join(root, CONFIG_FILE)
  const hasConfig = existsSync(configPath)

  if (hasConfig && options.coverage !== undefined) {
    throw new UsageError(
      `${CONFIG_FILE} already exists. Add the coverage command to it by hand.`
    )
  }

  const workflows = [
    HISTORY_WORKFLOW,
    ...(options.isPrComment ? [PR_WORKFLOW] : []),
  ]
  const taken = workflows.filter((path) => existsSync(join(root, path)))

  if (taken.length > 0 && !options.isForced) {
    throw new UsageError(
      `Already present: ${taken.join(", ")}. Pass --force to overwrite.`
    )
  }

  const cli = `npx -y ${pkg.name}@${pkg.version}`
  const hasCoverage =
    options.coverage !== undefined || config.coverage.length > 0
  const written: string[] = []

  if (!hasConfig) {
    const fresh = {
      $schema: `https://unpkg.com/${pkg.name}@${pkg.version}/crap-check.schema.json`,
      ...(options.coverage === undefined ?
        {}
      : {
          coverage: [
            { cwd: ".", command: options.coverage, lcov: "coverage/lcov.info" },
          ],
        }),
    }

    await write(configPath, `${JSON.stringify(fresh, null, 2)}\n`)
    written.push(CONFIG_FILE)
  }

  await write(
    join(root, HISTORY_WORKFLOW),
    renderHistoryWorkflow({
      cron: options.cron,
      mode: options.mode,
      branch: options.branch,
      ref: options.ref,
      outDir: config.outDir,
      install: hasCoverage ? detectPackageManager(root) : null,
      cli,
    })
  )
  written.push(HISTORY_WORKFLOW)

  if (options.isPrComment) {
    await write(
      join(root, PR_WORKFLOW),
      renderPrWorkflow({ outDir: config.outDir, cli })
    )
    written.push(PR_WORKFLOW)
  }

  return written
}

export const initCommand = async (
  context: Context,
  argv: string[]
): Promise<void> => {
  const options = parseInitArgs(context, argv)
  const written = await runInit(context, options)

  for (const path of written) {
    console.error(`wrote ${path}`)
  }

  console.error(
    [
      "",
      `Add ${context.config.outDir} to .prettierignore and similar tool ignores: its JSON is machine-written.`,
      `Add ${context.config.outDir}/snapshot.json to .gitignore.`,
      ...(options.mode === "pr" ?
        [
          "PR mode needs the repository setting",
          '"Allow GitHub Actions to create and approve pull requests" (Settings > Actions > General).',
        ]
      : [
          `Push mode needs ${options.branch} to accept pushes from GITHUB_TOKEN; a protected branch rejects them. Use --mode pr in that case.`,
        ]),
    ].join("\n")
  )
}
