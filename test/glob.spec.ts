import { describe, expect, it } from "bun:test"
import { globToRegExp, matcher } from "../src/lib/glob"

const matches = (pattern: string, path: string): boolean =>
  globToRegExp(pattern).test(path)

describe("globToRegExp", () => {
  it("matches `*` inside one segment only", () => {
    expect(matches("src/*.ts", "src/a.ts")).toBe(true)
    expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false)
  })

  it("matches `**/` as zero or more segments", () => {
    expect(matches("**/dist/**", "dist/a.js")).toBe(true)
    expect(matches("**/dist/**", "packages/a/dist/b/c.js")).toBe(true)
    expect(matches("**/dist/**", "distant/a.js")).toBe(false)
  })

  it("anchors the pattern to the whole path", () => {
    expect(matches("dist/**", "packages/dist/a.js")).toBe(false)
    expect(matches("*.ts", "a.tsx")).toBe(false)
  })

  it("matches `?` as one character but `/`", () => {
    expect(matches("a?.ts", "ab.ts")).toBe(true)
    expect(matches("a?.ts", "a/.ts")).toBe(false)
  })

  it("expands `{a,b}` alternation", () => {
    expect(matches("**/*.d.{ts,mts}", "x/y.d.mts")).toBe(true)
    expect(matches("**/*{.,_}{test,spec}.*", "a_spec.js")).toBe(true)
    expect(matches("**/*{.,_}{test,spec}.*", "latest.ts")).toBe(false)
  })

  it("escapes regular expression characters", () => {
    expect(matches("a.ts", "abts")).toBe(false)
    expect(matches("(x)+.ts", "(x)+.ts")).toBe(true)
  })

  it("rejects an unbalanced brace", () => {
    expect(() => globToRegExp("{a,b")).toThrow("Unbalanced")
  })
})

describe("matcher", () => {
  it("matches any of the patterns", () => {
    const isMatch = matcher(["*.md", "docs/**"])

    expect(isMatch("README.md")).toBe(true)
    expect(isMatch("docs/a/b.ts")).toBe(true)
    expect(isMatch("src/a.ts")).toBe(false)
  })

  it("matches nothing for an empty list", () => {
    expect(matcher([])("a")).toBe(false)
  })
})
