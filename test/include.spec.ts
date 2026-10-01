import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../src/lib/config"
import { createScope, ROOT_WORKSPACE } from "../src/lib/include"

/** The population rules for the default config, and for the knobs that change them. */

const scope = createScope(DEFAULT_CONFIG, [
  "package.json",
  "packages/utils/package.json",
  "packages/utils/nested/tool/package.json",
  "apps/web/package.json",
  "node_modules/left-pad/package.json",
])

describe("isMeasured", () => {
  it.each([
    "src/index.ts",
    "src/view.tsx",
    "src/legacy.js",
    "src/legacy.jsx",
    "src/esm.mjs",
    "src/cjs.cjs",
    "src/esm.mts",
    "packages/utils/src/dates.ts",
    // A substring of an excluded name is not that name.
    "src/distance.ts",
    "src/rebuild/index.ts",
    // A source folder named build, below a package root.
    "apps/web/src/order/build/create.ts",
  ])("measures %s", (path) => {
    expect(scope.isMeasured(path)).toBe(true)
  })

  it.each([
    ["README.md", "not a measured extension"],
    ["src/style.css", "not a measured extension"],
    ["node_modules/x/index.js", "dependency"],
    ["packages/a/node_modules/x/index.js", "nested dependency"],
    ["dist/index.js", "build output"],
    ["packages/a/build/index.js", "build output"],
    ["build/index.js", "build output"],
    ["apps/web/out/index.js", "build output"],
    ["coverage/lcov-report/prettify.js", "coverage output"],
    ["src/generated/api.ts", "generated"],
    ["src/__generated__/graphql.ts", "generated"],
    ["src/types.d.ts", "declaration"],
    ["src/types.d.mts", "declaration"],
    ["public/vendor/jquery.min.js", "minified"],
  ])("skips %s (%s)", (path) => {
    expect(scope.isMeasured(path)).toBe(false)
  })

  it("adds config excludes to the defaults", () => {
    const custom = createScope(
      { ...DEFAULT_CONFIG, exclude: ["**/schema.ts"] },
      []
    )

    expect(custom.isMeasured("src/db/schema.ts")).toBe(false)
    expect(custom.isMeasured("dist/a.ts")).toBe(false)
    expect(custom.isMeasured("src/db/sunsetSchema.ts")).toBe(true)
  })

  it("reads only the configured extensions", () => {
    const tsOnly = createScope(
      { ...DEFAULT_CONFIG, extensions: [".ts", ".tsx"] },
      []
    )

    expect(tsOnly.isMeasured("src/a.js")).toBe(false)
    expect(tsOnly.isMeasured("src/a.ts")).toBe(true)
  })
})

describe("isTest", () => {
  it.each([
    "src/a.test.ts",
    "src/a.spec.tsx",
    "src/a_test.js",
    "src/__tests__/a.ts",
    "src/__mocks__/fs.ts",
    "src/__fixtures__/listing.ts",
    "test/helpers.ts",
    "packages/a/tests/setup.ts",
  ])("reads %s as a test", (path) => {
    expect(scope.isTest(path)).toBe(true)
  })

  it.each(["src/testHarness.ts", "src/protest/index.ts", "src/latest.ts"])(
    "reads %s as source",
    (path) => {
      expect(scope.isTest(path)).toBe(false)
    }
  )

  it("replaces the defaults when the config sets test globs", () => {
    const custom = createScope({ ...DEFAULT_CONFIG, test: ["e2e/**"] }, [])

    expect(custom.isTest("e2e/login.ts")).toBe(true)
    expect(custom.isTest("src/a.test.ts")).toBe(false)
  })
})

describe("workspaceOf", () => {
  it.each([
    ["packages/utils/src/dates.ts", "packages/utils"],
    ["apps/web/app/page.tsx", "apps/web"],
    // The nearest package.json wins over an outer one.
    ["packages/utils/nested/tool/index.ts", "packages/utils/nested/tool"],
    ["src/index.ts", ROOT_WORKSPACE],
    ["scripts/build.ts", ROOT_WORKSPACE],
  ])("puts %s in %s", (path, workspace) => {
    expect(scope.workspaceOf(path)).toBe(workspace)
  })

  it("ignores package.json files under node_modules", () => {
    expect(scope.workspaceOf("node_modules/left-pad/index.js")).toBe(
      ROOT_WORKSPACE
    )
  })

  it("uses the config globs when they are set", () => {
    const globbed = createScope(
      { ...DEFAULT_CONFIG, workspaces: ["apps/*", "infra/*"] },
      ["packages/utils/package.json"]
    )

    expect(globbed.workspaceOf("apps/web/src/a.ts")).toBe("apps/web")
    expect(globbed.workspaceOf("infra/gvc/main.ts")).toBe("infra/gvc")
    // Globs replace detection, so a package.json outside them does not count.
    expect(globbed.workspaceOf("packages/utils/a.ts")).toBe(ROOT_WORKSPACE)
    // A file directly in `apps` is not inside any workspace.
    expect(globbed.workspaceOf("apps/readme.ts")).toBe(ROOT_WORKSPACE)
  })
})
