import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createFixture } from "./fixture"

/**
 * The CLI end to end, through `src/cli.ts`, against a repository with three
 * weeks of history and a coverage command that writes a real lcov file.
 */

const CLI = join(import.meta.dir, "..", "src", "cli.ts")

const COMPLEX = `export const grade = (n: number): string => {
  if (n > 90) {
    return "a"
  }
  if (n > 80) {
    return "b"
  }
  if (n > 70) {
    return "c"
  }
  if (n > 60) {
    return "d"
  }
  return n > 50 ? "e" : "f"
}
`

/** Writes an lcov report that covers the first three lines of `src/grade.ts`. */
const FAKE_COVERAGE = `mkdir -p coverage && printf 'TN:\\nSF:src/grade.ts\\nDA:1,1\\nDA:2,1\\nDA:3,1\\nDA:4,0\\nDA:5,0\\nDA:6,0\\nDA:7,0\\nDA:8,0\\nDA:9,0\\nDA:10,0\\nDA:11,0\\nDA:12,0\\nDA:13,0\\nDA:14,0\\nDA:15,0\\nend_of_record\\n' > coverage/lcov.info`

describe("crap-check CLI", () => {
  const fixture = createFixture()
  const run = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: fixture.dir,
      encoding: "utf8",
    })

  fixture.commit({
    files: {
      "package.json": "{}\n",
      "src/a.ts": "export const a = (x: number) => (x ? 1 : 2)\n",
      "crap-check.config.json": JSON.stringify({
        ref: "main",
        coverage: [{ command: FAKE_COVERAGE }],
      }),
    },
    message: "one",
    at: "2026-01-05T09:00:00Z",
  })
  fixture.commit({
    files: { "src/grade.ts": COMPLEX },
    message: "two",
    at: "2026-01-12T09:00:00Z",
  })
  fixture.commit({
    files: { "src/grade.spec.ts": "if (1) { void 0 }\n" },
    message: "three",
    at: "2026-01-19T09:00:00Z",
  })

  afterAll(fixture.remove)

  it("measures the working tree by default", () => {
    const result = run(["--top", "1"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("source  files=2")
    expect(result.stdout).toContain("src/grade.ts:1")
  })

  it("prints help and the version", () => {
    expect(run(["--help"]).stdout).toContain("Usage: crap-check")
    expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("fails cleanly on an unknown command or flag", () => {
    const unknown = run(["nope"])

    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('Unknown command "nope"')

    const flag = run(["history", "--bogus"])

    expect(flag.status).toBe(1)
    expect(flag.stderr).toStartWith("crap-check:")
  })

  it("refreshes history, charts and CRAP in one run", () => {
    const result = run(["refresh"])

    expect(result.status).toBe(0)

    const out = join(fixture.dir, ".complexity")
    const history = JSON.parse(readFileSync(join(out, "history.json"), "utf8"))

    expect(history.weeks.map((week: { week: string }) => week.week)).toEqual([
      "2026-W02",
      "2026-W03",
      "2026-W04",
    ])
    expect(existsSync(join(out, "history.svg"))).toBe(true)
    expect(existsSync(join(out, "history-cognitive.svg"))).toBe(true)
    expect(readFileSync(join(out, "history.svg"), "utf8")).toContain(
      "commit of main"
    )

    const crap = JSON.parse(readFileSync(join(out, "crap.json"), "utf8"))

    expect(crap.totals.scored).toBe(1)
    expect(crap.worst[0].path).toBe("src/grade.ts")
    expect(crap.coverage.unmeasured).toEqual([])
    expect(existsSync(join(out, "crap-history.json"))).toBe(true)
  })

  it("is incremental: a second history run keeps the old weeks", () => {
    const result = run(["history"])

    expect(result.status).toBe(0)
    expect(result.stderr).toContain("3 weeks, 1 to measure")
  })

  it("reports a diff between two commits as markdown", () => {
    const result = run(["diff", "--base", "HEAD~2", "--head", "HEAD"])

    expect(result.status).toBe(0)
    expect(result.stdout).toStartWith("<!-- crap-check-report -->")
    expect(result.stdout).toContain("src/grade.ts")
  })
})
