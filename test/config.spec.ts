import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_CONFIG,
  DEFAULT_EXCLUDE,
  loadConfig,
  parseConfig,
  resolveRef,
} from "../src/lib/config"
import { createFixture } from "./fixture"

describe("parseConfig", () => {
  it("returns the defaults for an empty object", () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it("accepts a $schema key", () => {
    expect(parseConfig({ $schema: "x" })).toEqual(DEFAULT_CONFIG)
  })

  it("rejects an unknown key, so a typo does not silently do nothing", () => {
    expect(() => parseConfig({ exlude: [] })).toThrow('unknown key "exlude"')
  })

  it("rejects a non-object", () => {
    expect(() => parseConfig([])).toThrow(ConfigError)
  })

  it("keeps the default excludes when the config adds its own", () => {
    const config = parseConfig({ exclude: ["**/schema.ts"] })

    expect(config.exclude).toEqual(["**/schema.ts"])
    // The defaults apply separately, in `createScope`.
    expect(DEFAULT_EXCLUDE).toContain("**/dist/**")
  })

  it("rejects an invalid glob with a config error", () => {
    expect(() => parseConfig({ exclude: ["{a"] })).toThrow(ConfigError)
  })

  it("fills coverage defaults", () => {
    expect(
      parseConfig({ coverage: [{ command: "bun test" }] }).coverage
    ).toEqual([{ cwd: ".", command: "bun test", lcov: "coverage/lcov.info" }])
  })

  it("rejects a coverage entry without a command", () => {
    expect(() => parseConfig({ coverage: [{ cwd: "." }] })).toThrow(
      "coverage[0].command"
    )
  })

  it("validates event weeks", () => {
    expect(
      parseConfig({ events: [{ week: "2026-W03", label: "v2" }] }).events
    ).toEqual([{ week: "2026-W03", label: "v2" }])
    expect(() =>
      parseConfig({ events: [{ week: "2026-01-01", label: "v2" }] })
    ).toThrow("events[0]")
  })

  it("accepts null workspaces as detection", () => {
    expect(parseConfig({ workspaces: null }).workspaces).toBeNull()
    expect(parseConfig({ workspaces: ["apps/*"] }).workspaces).toEqual([
      "apps/*",
    ])
  })
})

describe("loadConfig and resolveRef", () => {
  const fixture = createFixture()

  fixture.commit({
    files: { "a.ts": "" },
    message: "first",
    at: "2026-01-05T09:00:00Z",
  })

  afterAll(fixture.remove)

  it("returns the defaults when there is no file", () => {
    expect(loadConfig(fixture.dir)).toEqual(DEFAULT_CONFIG)
  })

  it("reports invalid JSON as a config error", () => {
    writeFileSync(join(fixture.dir, CONFIG_FILE), "{")

    expect(() => loadConfig(fixture.dir)).toThrow(ConfigError)
  })

  it("prefers the configured ref", () => {
    expect(
      resolveRef(fixture.dir, { ...DEFAULT_CONFIG, ref: "origin/dev" })
    ).toBe("origin/dev")
  })

  it("falls back to HEAD when there is no remote", () => {
    expect(resolveRef(fixture.dir, DEFAULT_CONFIG)).toBe("HEAD")
  })

  it("finds origin/main when origin/HEAD is not set", () => {
    fixture.git(["update-ref", "refs/remotes/origin/main", "HEAD"])

    expect(resolveRef(fixture.dir, DEFAULT_CONFIG)).toBe("origin/main")
  })
})

describe("crap-check.schema.json", () => {
  it("lists exactly the keys parseConfig accepts", () => {
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "crap-check.schema.json"),
        "utf8"
      )
    )

    expect(Object.keys(schema.properties).toSorted()).toEqual(
      ["$schema", ...Object.keys(DEFAULT_CONFIG)].toSorted()
    )
  })
})
