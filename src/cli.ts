#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" }
import { chartCommand } from "./commands/chart"
import { createContext, UsageError, type Context } from "./commands/context"
import { coverageCommand } from "./commands/coverage"
import { crapCommand } from "./commands/crap"
import { diffCommand } from "./commands/diff"
import { historyCommand } from "./commands/history"
import { initCommand } from "./commands/init"
import { measureCommand } from "./commands/measure"
import { refreshCommand } from "./commands/refresh"
import { ConfigError } from "./lib/config"

/** The `crap-check` binary: one subcommand per verb, `measure` when none is given. */

type Command = (context: Context, argv: string[]) => Promise<void>

const COMMANDS: Record<string, Command> = {
  measure: measureCommand,
  history: historyCommand,
  chart: chartCommand,
  diff: diffCommand,
  coverage: coverageCommand,
  crap: crapCommand,
  refresh: refreshCommand,
  init: initCommand,
}

const HELP = `crap-check ${pkg.version}: cyclomatic, cognitive and CRAP complexity

Usage: crap-check <command> [options]

Commands:
  measure   [--json] [--top N] [--write]        Measure the working tree (default)
  history   [--ref R] [--since YYYY-Www] [--rebuild]
                                                Build the weekly history from git
  chart     [--metric cyclomatic|cognitive] [--out path]
                                                Draw the history as SVG
  diff      --base B [--head H] [--markdown file] [--json file]
                                                Report the delta between two commits
  coverage  [--only cwd,cwd]                    Run the configured coverage commands
  crap      [--top N] [--no-history] [--stale]  Score functions with CRAP
  refresh   [--ref R] [--rebuild]               history + charts + coverage + crap
  init      [--cadence weekly|daily|monthly | --cron "m h dom mon dow"]
            [--mode push|pr] [--branch B] [--ref R] [--pr-comment]
            [--coverage "cmd"] [--force]        Write the config and GitHub workflows

Config: crap-check.config.json at the repository root. See the README.`

const main = async (argv: string[]): Promise<void> => {
  const [first, ...rest] = argv

  if (first === "--help" || first === "-h" || first === "help") {
    console.log(HELP)
    return
  }

  if (first === "--version" || first === "-v") {
    console.log(pkg.version)
    return
  }

  const isFlag = first === undefined || first.startsWith("-")
  const name = isFlag ? "measure" : first
  const command = COMMANDS[name]

  if (command === undefined) {
    throw new UsageError(`Unknown command "${name}". Run: crap-check --help`)
  }

  await command(createContext(), isFlag ? argv : rest)
}

const isUserError = (error: unknown): error is Error =>
  error instanceof UsageError ||
  error instanceof ConfigError ||
  // `parseArgs` rejects unknown flags with this code.
  (error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS"))

main(process.argv.slice(2)).catch((error: unknown) => {
  if (isUserError(error)) {
    console.error(`crap-check: ${error.message}`)
  } else {
    console.error(error)
  }

  process.exitCode = 1
})
