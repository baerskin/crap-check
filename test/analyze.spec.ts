import { describe, expect, it } from "bun:test"
import ts from "typescript"
import { analyze } from "../src/lib/analyze"

/**
 * Every row here is one decision point of the ESLint `complexity` rule, isolated.
 * `oracle.spec.ts` proves the whole set agrees with ESLint on real files; this
 * file says which node is responsible when that parity breaks.
 */

/** Complexity of the only unit in a snippet. Fails loudly on a miscount of units. */
const only = (source: string, path = "t.ts"): number => {
  const file = analyze(path, source, ts)

  expect(file.units).toHaveLength(1)

  return (file.units[0] as { complexity: number }).complexity
}

describe("analyze — the baseline unit", () => {
  it("seeds every unit at 1", () => {
    expect(only("const f = () => {}")).toBe(1)
  })

  it("opens a unit for each function form", () => {
    const source = `
      function decl() {}
      const expr = function () {}
      const arrow = () => {}
      class C {
        constructor() {}
        method() {}
        get value() { return 1 }
        set value(next: number) {}
        static { const x = 1 }
        field = 1
      }
    `
    const kinds = analyze("t.ts", source, ts).units.map((unit) => unit.kind)

    expect(kinds.toSorted()).toEqual([
      "arrow",
      "constructor",
      "fieldInitializer",
      "function",
      "function",
      "getter",
      "method",
      "setter",
      "staticBlock",
    ])
  })

  it("leaves a field with no value out: nothing is evaluated", () => {
    expect(analyze("t.ts", "class C { declared: number }", ts).units).toEqual(
      []
    )
  })

  it("leaves every bodyless signature out", () => {
    // Overloads and abstract members declare nothing to execute. ESLint never
    // sees them, so counting them puts a phantom 1 in the file.
    const source = `
      function over(a: string): string
      function over(a: number): number
      function over(a: unknown) { return a }
      abstract class Gateway {
        abstract charge(a: number): void
        abstract get ready(): boolean
        concrete() { return 1 }
      }
      declare function ambient(a: number): number
    `
    const kinds = analyze("t.ts", source, ts).units.map((unit) => unit.kind)

    expect(kinds).toEqual(["function", "method"])
  })
})

describe("analyze — branching statements", () => {
  it("counts if, and counts else nothing extra", () => {
    expect(only("const f = (a: number) => { if (a) {} }")).toBe(2)
    expect(only("const f = (a: number) => { if (a) {} else {} }")).toBe(2)
  })

  it("counts every loop form once", () => {
    expect(only("const f = () => { for (;;) {} }")).toBe(2)
    expect(only("const f = (o: object) => { for (const k in o) {} }")).toBe(2)
    expect(only("const f = (l: number[]) => { for (const n of l) {} }")).toBe(2)
    expect(only("const f = (a: boolean) => { while (a) {} }")).toBe(2)
    expect(only("const f = (a: boolean) => { do {} while (a) }")).toBe(2)
  })

  it("counts case and never default", () => {
    const withDefault = `const f = (a: number) => {
      switch (a) { case 1: break; case 2: break; default: break }
    }`

    expect(only(withDefault)).toBe(3)
  })

  it("counts catch, and a try without one adds nothing", () => {
    expect(only("const f = () => { try {} finally {} }")).toBe(1)
    expect(only("const f = () => { try {} catch {} }")).toBe(2)
  })

  it("counts a ternary", () => {
    expect(only("const f = (a: number) => (a ? 1 : 2)")).toBe(2)
  })
})

describe("analyze — operators", () => {
  it("counts each short-circuit operator", () => {
    expect(only("const f = (a: number, b: number) => a && b")).toBe(2)
    expect(only("const f = (a: number, b: number) => a || b")).toBe(2)
    expect(only("const f = (a: number, b: number) => a ?? b")).toBe(2)
  })

  it("counts the logical assignment forms the same as their operators", () => {
    expect(only("const f = (a: { v?: number }) => { a.v ??= 1 }")).toBe(2)
    expect(only("const f = (a: { v: number }) => { a.v ||= 1 }")).toBe(2)
    expect(only("const f = (a: { v: number }) => { a.v &&= 1 }")).toBe(2)
  })

  it("counts every link of an optional chain", () => {
    // Two `?.`, so two decision points. A chain is not one branch.
    expect(only("const f = (a?: { b?: { c: number } }) => a?.b?.c")).toBe(3)
  })

  it("counts an optional call and an optional index", () => {
    expect(only("const f = (a?: () => void) => a?.()")).toBe(2)
    expect(only("const f = (a?: number[]) => a?.[0]")).toBe(2)
  })
})

describe("analyze — default values", () => {
  it("counts a default parameter", () => {
    expect(only("const f = (a = 1) => a")).toBe(2)
  })

  it("counts a default inside a destructured parameter", () => {
    expect(only("const f = ({ a = 1 }: { a?: number }) => a")).toBe(2)
  })

  it("attributes a nested arrow's default to that arrow, not its parent", () => {
    const file = analyze("t.ts", "function outer() { return (a = 1) => a }", ts)
    const byKind = Object.fromEntries(
      file.units.map((unit) => [unit.kind, unit.complexity])
    )

    expect(byKind).toEqual({ function: 1, arrow: 2 })
  })
})

describe("analyze — scoping", () => {
  it("sends a decision point outside every unit to moduleComplexity", () => {
    const file = analyze("t.ts", "const flag = 1 > 0 ? 'a' : 'b'", ts)

    expect(file.units).toEqual([])
    expect(file.moduleComplexity).toBe(1)
    expect(file.total).toBe(1)
  })

  it("keeps moduleComplexity out of the units but inside the total", () => {
    const file = analyze(
      "t.ts",
      "const flag = 1 > 0 ? 'a' : 'b'\nconst f = (a: number) => (a ? 1 : 2)",
      ts
    )

    expect(file.moduleComplexity).toBe(1)
    expect(file.max).toBe(2)
    expect(file.total).toBe(3)
  })

  it("nests a unit inside the unit that declares it", () => {
    const file = analyze(
      "t.ts",
      "const outer = (a: number) => { if (a) {} return () => (a ? 1 : 2) }",
      ts
    )

    expect(file.units.map((unit) => unit.complexity)).toEqual([2, 2])
    expect(file.total).toBe(4)
    expect(file.max).toBe(2)
  })

  it("makes a class field holding a function two units, as ESLint does", () => {
    // `packages/utils/src/boot.ts` is the real case: ESLint reports both
    // "Async method 'init'" and "Class field initializer" on one line.
    const file = analyze(
      "t.ts",
      "class Boot { close = async (hard = false) => { if (hard) {} } }",
      ts
    )

    expect(file.units.map((unit) => [unit.kind, unit.complexity])).toEqual([
      ["fieldInitializer", 1],
      ["arrow", 3],
    ])
  })
})

describe("analyze — naming", () => {
  it("takes the name from whatever holds an anonymous function", () => {
    const file = analyze(
      "t.ts",
      "const handleOrder = () => {}\nconst obj = { onTick: function () {} }",
      ts
    )

    expect(file.units.map((unit) => unit.name)).toEqual([
      "handleOrder",
      "onTick",
    ])
  })

  it("qualifies a class member with its class", () => {
    const file = analyze("t.ts", "class Boot { close() {} }", ts)

    expect(file.units[0]?.name).toBe("Boot.close")
  })

  it("falls back to <anonymous> when nothing names it", () => {
    const file = analyze("t.ts", "export default [1].map(function () {})", ts)

    expect(file.units[0]?.name).toBe("<anonymous>")
  })
})

describe("analyze — line range", () => {
  it("spans a unit from its first token to its last", () => {
    const file = analyze("t.ts", "\nfunction a() {\n  return 1\n}\n", ts)

    expect(file.units[0]).toMatchObject({ line: 2, endLine: 4 })
  })

  it("puts a one-line unit on one line", () => {
    const file = analyze("t.ts", "const a = () => 1", ts)

    expect(file.units[0]).toMatchObject({ line: 1, endLine: 1 })
  })

  it("nests a callback inside its owner's range, which is how coverage reads", () => {
    const file = analyze(
      "t.ts",
      "function outer() {\n  return [1].map(function inner() {\n    return 2\n  })\n}\n",
      ts
    )

    const outer = file.units.find((unit) => unit.name === "outer")
    const inner = file.units.find((unit) => unit.name === "inner")

    expect(outer).toMatchObject({ line: 1, endLine: 5 })
    expect(inner?.line).toBeGreaterThan(outer?.line ?? 0)
    expect(inner?.endLine).toBeLessThan(outer?.endLine ?? 0)
  })

  it("counts a decorator as part of the method it decorates", () => {
    // A decorator is a modifier, so the node starts at it. Coverage reads the
    // range, and the decorator line runs when the class is defined, so charging
    // it to the method is the reading that needs no special case.
    const file = analyze(
      "t.ts",
      "class Boot {\n  @log\n  close() {\n    return 1\n  }\n}\n",
      ts
    )

    expect(file.units[0]).toMatchObject({ line: 2, endLine: 5 })
  })
})

describe("analyze — file metadata", () => {
  it("parses .tsx as TSX, where a lone type parameter is JSX", () => {
    // Under ScriptKind.TS this parses as a generic arrow and reports one unit.
    // Under TSX it is a JSX element, so the file declares no unit at all.
    const file = analyze("t.tsx", "const el = <Foo>bar</Foo>", ts)

    expect(file.units).toEqual([])
  })

  it("parses .jsx as JSX and .js as JavaScript", () => {
    expect(analyze("t.jsx", "const el = <Foo>bar</Foo>", ts).units).toEqual([])
    expect(only("export function f(a) { return a ? 1 : 2 }", "t.js")).toBe(2)
  })

  it("still parses generics in .tsx when they are unambiguous", () => {
    expect(only("const f = <T,>(a: T) => a", "t.tsx")).toBe(1)
  })

  it("reports the line count", () => {
    const file = analyze("x.ts", "const f = () => {}\n", ts)

    // One line, not two. The trailing newline ends a line, it does not open one.
    expect(file.lines).toBe(1)
  })

  it("counts lines the way `wc -l` does", () => {
    const lines = (source: string): number => analyze("t.ts", source, ts).lines

    expect(lines("")).toBe(0)
    expect(lines("a\n")).toBe(1)
    expect(lines("a\nb")).toBe(2)
    expect(lines("a\nb\n")).toBe(2)
  })

  it("reports a 1-based line for each unit", () => {
    const file = analyze("t.ts", "\n\nconst f = () => {}", ts)

    expect(file.units[0]?.line).toBe(3)
  })
})
