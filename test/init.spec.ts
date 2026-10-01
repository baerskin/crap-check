import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }
import {
  CADENCES,
  detectPackageManager,
  HISTORY_WORKFLOW,
  parseInitArgs,
  PR_WORKFLOW,
  runInit,
} from "../src/commands/init"
import { CONFIG_FILE, DEFAULT_CONFIG } from "../src/lib/config"
import { MARKER } from "../src/lib/report"
import {
  ACTIONS,
  renderHistoryWorkflow,
  renderPrWorkflow,
  type HistoryWorkflowOptions,
} from "../src/templates/workflows"
import { createFixture } from "./fixture"

const CLI = `npx -y ${pkg.name}@${pkg.version}`

const base: HistoryWorkflowOptions = {
  cron: CADENCES.weekly,
  mode: "push",
  branch: "main",
  ref: "origin/main",
  outDir: ".complexity",
  install: null,
  cli: CLI,
}

describe("parseInitArgs", () => {
  const fixture = createFixture()

  fixture.commit({
    files: { "a.ts": "" },
    message: "first",
    at: "2026-01-05T09:00:00Z",
  })
  fixture.git(["update-ref", "refs/remotes/origin/develop", "HEAD"])
  fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/develop",
  ])

  afterAll(fixture.remove)

  const parse = (argv: string[]) =>
    parseInitArgs({ root: fixture.dir, config: DEFAULT_CONFIG }, argv)

  it("defaults to weekly push on the remote default branch", () => {
    expect(parse([])).toEqual({
      cron: CADENCES.weekly,
      mode: "push",
      branch: "develop",
      ref: "origin/develop",
      isPrComment: false,
      coverage: undefined,
      isForced: false,
    })
  })

  it("maps cadences to cron expressions", () => {
    expect(parse(["--cadence", "daily"]).cron).toBe("0 6 * * *")
    expect(parse(["--cadence", "monthly"]).cron).toBe("0 6 1 * *")
  })

  it("accepts a custom cron", () => {
    expect(parse(["--cron", "30 4 * * 1-5"]).cron).toBe("30 4 * * 1-5")
  })

  it("rejects a cron that is not five fields", () => {
    expect(() => parse(["--cron", "0 6 * *"])).toThrow("five cron fields")
    expect(() => parse(["--cron", "0 6 * * 1; rm -rf /"])).toThrow()
  })

  it("rejects --cadence with --cron", () => {
    expect(() => parse(["--cadence", "daily", "--cron", "0 6 * * *"])).toThrow(
      "not both"
    )
  })

  it("rejects an unknown cadence or mode", () => {
    expect(() => parse(["--cadence", "hourly"])).toThrow("--cadence")
    expect(() => parse(["--mode", "merge"])).toThrow("--mode")
  })

  it("rejects a branch a workflow cannot carry", () => {
    expect(() => parse(["--branch", "main; echo"])).toThrow("--branch")
  })
})

describe("renderHistoryWorkflow", () => {
  it("pins the CLI and every action", () => {
    const yaml = renderHistoryWorkflow(base)

    expect(yaml).toContain(`${CLI} refresh --ref origin/main`)
    expect(yaml).toContain(`uses: ${ACTIONS.checkout}`)
    expect(yaml).toContain(`uses: ${ACTIONS.setupNode}`)
    expect(yaml).toMatch(/@[0-9a-f]{40} # v/)
  })

  it("writes the schedule", () => {
    expect(renderHistoryWorkflow(base)).toContain('- cron: "0 6 * * 1"')
  })

  it("pushes with a retry in push mode", () => {
    const yaml = renderHistoryWorkflow(base)

    expect(yaml).toContain("git push origin HEAD:refs/heads/main")
    expect(yaml).toContain("for attempt in 1 2 3")
    expect(yaml).not.toContain("pull-requests: write")
    expect(yaml).not.toContain("gh pr create")
  })

  it("opens a pull request in pr mode", () => {
    const yaml = renderHistoryWorkflow({ ...base, mode: "pr" })

    expect(yaml).toContain("pull-requests: write")
    expect(yaml).toContain("GH_TOKEN: ${{ github.token }}")
    expect(yaml).toContain("refs/heads/crap-check/refresh")
    expect(yaml).toContain("gh pr create --base main")
    expect(yaml).not.toContain("for attempt in")
  })

  it("installs dependencies only when coverage needs them", () => {
    expect(renderHistoryWorkflow(base)).not.toContain("install")
    expect(renderHistoryWorkflow({ ...base, install: "npm" })).toContain(
      "- run: npm ci"
    )

    const bun = renderHistoryWorkflow({ ...base, install: "bun" })

    expect(bun).toContain(`uses: ${ACTIONS.setupBun}`)
    expect(bun).toContain("bun install --frozen-lockfile")
  })

  it("stages only the output directory", () => {
    expect(renderHistoryWorkflow({ ...base, outDir: "metrics" })).toContain(
      "git add metrics"
    )
  })

  it("adds no tab characters, which YAML rejects", () => {
    expect(renderHistoryWorkflow({ ...base, mode: "pr" })).not.toContain("\t")
  })
})

describe("renderPrWorkflow", () => {
  const yaml = renderPrWorkflow({ outDir: ".complexity", cli: CLI })

  it("finds its comment by the report marker", () => {
    expect(yaml).toContain(`startswith("${MARKER}")`)
  })

  it("diffs from the merge base", () => {
    expect(yaml).toContain(`${CLI} diff`)
    expect(yaml).toContain('--base "$(git merge-base "origin/$BASE" HEAD)"')
  })

  it("keeps GitHub expressions intact", () => {
    expect(yaml).toContain("${{ github.event.pull_request.number }}")
    expect(yaml).not.toContain("\\${{")
  })

  it("skips forks and dependabot", () => {
    expect(yaml).toContain("dependabot[bot]")
    expect(yaml).toContain("head.repo.full_name == github.repository")
  })
})

describe("runInit", () => {
  const fixture = createFixture()

  fixture.commit({
    files: { "a.ts": "", "bun.lock": "" },
    message: "first",
    at: "2026-01-05T09:00:00Z",
  })

  afterAll(fixture.remove)

  const context = { root: fixture.dir, config: DEFAULT_CONFIG }
  const options = parseInitArgs(context, [
    "--pr-comment",
    "--coverage",
    "bun test --coverage --coverage-reporter=lcov",
  ])

  it("detects the package manager from the lockfile", () => {
    expect(detectPackageManager(fixture.dir)).toBe("bun")
  })

  it("writes the config and both workflows", async () => {
    const written = await runInit(context, options)

    expect(written).toEqual([CONFIG_FILE, HISTORY_WORKFLOW, PR_WORKFLOW])
    expect(existsSync(join(fixture.dir, PR_WORKFLOW))).toBe(true)

    const config = JSON.parse(
      readFileSync(join(fixture.dir, CONFIG_FILE), "utf8")
    )

    expect(config.coverage).toEqual([
      {
        cwd: ".",
        command: "bun test --coverage --coverage-reporter=lcov",
        lcov: "coverage/lcov.info",
      },
    ])
    expect(readFileSync(join(fixture.dir, HISTORY_WORKFLOW), "utf8")).toContain(
      "bun install --frozen-lockfile"
    )
  })

  it("refuses to overwrite a workflow without --force", async () => {
    await expect(
      runInit(context, { ...options, coverage: undefined })
    ).rejects.toThrow("--force")
  })

  it("overwrites workflows with --force and keeps the existing config", async () => {
    const written = await runInit(context, {
      ...options,
      coverage: undefined,
      isForced: true,
    })

    expect(written).toEqual([HISTORY_WORKFLOW, PR_WORKFLOW])
  })

  it("refuses --coverage when a config already exists", async () => {
    await expect(
      runInit(context, { ...options, isForced: true })
    ).rejects.toThrow("already exists")
  })
})
