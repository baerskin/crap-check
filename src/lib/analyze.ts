import type * as TS from "typescript"

/**
 * Counts two complexity metrics for one file, from its text alone.
 *
 * Cyclomatic is ESLint 10's `complexity` rule, node for node: `oracle.spec.ts`
 * tests against it, so a second implementation disagreeing is a visible bug.
 *
 * Cognitive is Appendix B of Cognitive Complexity v1.7 (G. Ann Campbell, Sonar,
 * 29 August 2023). It answers what cyclomatic cannot: a 30-case `switch`
 * costs 1, and four nested levels cost more than four flat branches. It has
 * no oracle, so the whitepaper's own worked examples are the fixtures.
 *
 * Parsing is syntax-only: `ts.createSourceFile` needs no program, checker or
 * tsconfig, which is what makes a 141-week historical backfill cheap: 158 MB
 * of source parses in about 15 seconds. A checker-based tool such as
 * `scan-service-types` takes that long for one commit.
 *
 * One divergence from the oracle is deliberate: ESLint reports functions and
 * class field initializers only, so a module-scope decision point is invisible
 * to it. Those land in `moduleComplexity`, kept apart from `units` so the
 * parity test compares like with like.
 */

/** What kind of thing a complexity unit is. */
export type UnitKind =
  | "function"
  | "method"
  | "arrow"
  | "constructor"
  | "getter"
  | "setter"
  | "fieldInitializer"
  | "staticBlock"

/** One thing with its own complexity score. */
export interface Unit {
  /** "handleOrder", "Boot.close", or "<anonymous>" when nothing names it. */
  name: string
  kind: UnitKind
  /** 1-based, at the unit's own first token. */
  line: number
  /**
   * 1-based, at the unit's last token. Coverage is attributed over
   * `[line, endLine]`: Bun's lcov reporter writes no per-function records.
   */
  endLine: number
  complexity: number
  /**
   * Cognitive complexity, including every unit nested inside this one, from
   * this unit's own start. A top-level unit carries the full cost of its
   * callbacks; the same callback read alone carries only its own. See
   * `owner` for how summing keeps the two views apart.
   */
  cognitive: number
  /**
   * The unit this one nests inside, as an index into `units`, or -1 at top
   * level. Only top-level units sum into the file: their scores already
   * include everything below them.
   */
  owner: number
}

/** Everything the metric knows about one file. */
export interface FileComplexity extends FileAnalysis {
  workspace: string
  isTest: boolean
}

/** What the text of one file says, before the scope places it in a workspace. */
export interface FileAnalysis {
  path: string
  lines: number
  units: Unit[]
  /** Decision points outside every unit. ESLint cannot see these. */
  moduleComplexity: number
  /** `sum(units) + moduleComplexity`. */
  total: number
  /** The worst single unit, or 0 when the file declares none. */
  max: number
  /** Cognitive increments outside every unit. */
  cognitiveModule: number
  /** `sum(top-level units) + cognitiveModule`. Nothing is counted twice. */
  cognitiveTotal: number
  /** The worst top-level unit, or 0 when the file declares none. */
  cognitiveMax: number
}

/** The decision points every one of which adds 1. Order follows the ESLint rule. */
export const DECISION_POINTS = [
  "if",
  "for",
  "for-in",
  "for-of",
  "while",
  "do",
  "case",
  "catch",
  "ternary",
  "&&",
  "||",
  "??",
  "&&=",
  "||=",
  "??=",
  "?.",
  "default-value",
] as const

/**
 * What cognitive complexity charges for, in the whitepaper's three groups.
 *
 * Everything absent is on purpose: `try`, `finally`, `default:`, `??`, `?.`,
 * the logical assignments, parameter defaults, `return`, and `throw` cost
 * nothing. Declaring a unit costs nothing either, so the file and workspace
 * sums mean something.
 */
export const COGNITIVE_RULES = {
  /** +1 wherever it sits. */
  flat: [
    "else-if",
    "else",
    "break-label",
    "continue-label",
    "logical-sequence",
  ],
  /** +1, plus one for each level of nesting it sits inside. */
  structural: [
    "if",
    "ternary",
    "switch",
    "for",
    "for-in",
    "for-of",
    "while",
    "do",
    "catch",
  ],
  /** Raises the nesting level for its own subtree. */
  nesting: [
    "if-branch",
    "else-branch",
    "ternary-branch",
    "case",
    "loop-body",
    "catch-body",
    "nested-unit",
  ],
} as const

/**
 * A signature with no body declares nothing to execute: an overload, an
 * abstract member, an ambient declaration. ESLint's rule does not visit
 * these (`TSDeclareFunction`, `TSAbstractMethodDefinition`), so counting
 * them would add phantom 1s to every file using overloads.
 */
const hasBody = (node: TS.Node): boolean =>
  (node as { body?: unknown }).body !== undefined

const unitKindOf = (node: TS.Node, ts: typeof TS): UnitKind | undefined => {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
      return hasBody(node) ? "function" : undefined
    case ts.SyntaxKind.ArrowFunction:
      return "arrow"
    case ts.SyntaxKind.MethodDeclaration:
      return hasBody(node) ? "method" : undefined
    case ts.SyntaxKind.Constructor:
      return hasBody(node) ? "constructor" : undefined
    case ts.SyntaxKind.GetAccessor:
      return hasBody(node) ? "getter" : undefined
    case ts.SyntaxKind.SetAccessor:
      return hasBody(node) ? "setter" : undefined
    case ts.SyntaxKind.ClassStaticBlockDeclaration:
      return "staticBlock"
    case ts.SyntaxKind.PropertyDeclaration:
      // A field is a unit only with a value to evaluate: `foo = () => {}` is
      // two units (field, arrow), matching ESLint.
      return (node as TS.PropertyDeclaration).initializer !== undefined ?
          "fieldInitializer"
        : undefined
    default:
      return undefined
  }
}

/**
 * The node under any number of wrappers that change no control flow.
 *
 * `(() => {}) as Fn` is the same function as `() => {}`; `((a && b))` is the
 * same as `a && b`. A cast or a spare parenthesis costs a reader nothing, so
 * it costs the score nothing either.
 */
const unwrap = (node: TS.Node, ts: typeof TS): TS.Node => {
  let bare = node

  while (
    ts.isParenthesizedExpression(bare) ||
    ts.isAsExpression(bare) ||
    ts.isSatisfiesExpression(bare) ||
    ts.isNonNullExpression(bare) ||
    ts.isTypeAssertionExpression(bare)
  ) {
    bare = bare.expression
  }

  return bare
}

/**
 * Whether a unit opens its own nesting level for cognitive complexity.
 *
 * `foo = () => {}` is two cyclomatic units but one function. Opening a level
 * for the field too would charge a class-field method one more than the same
 * code written as a method, so the field steps aside.
 */
const opensCognitiveFrame = (
  node: TS.Node,
  kind: UnitKind,
  ts: typeof TS
): boolean => {
  if (kind !== "fieldInitializer") {
    return true
  }

  const { initializer } = node as TS.PropertyDeclaration

  if (initializer === undefined) {
    return true
  }

  const bare = unwrap(initializer, ts)

  return !(ts.isArrowFunction(bare) || ts.isFunctionExpression(bare))
}

const LOGICAL_OPERATORS = (ts: typeof TS): Set<TS.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ])

/**
 * The operators that form a cognitive "sequence". `??` is absent: the
 * whitepaper ignores null-coalescing, since it shortens code that would
 * otherwise be an `if`.
 */
const SEQUENCE_OPERATORS = (ts: typeof TS): Set<TS.SyntaxKind> =>
  new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken])

const DECISION_KINDS = (ts: typeof TS): Set<TS.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.CatchClause,
    ts.SyntaxKind.ConditionalExpression,
    // `CaseClause` only. A `default` branches nothing.
    ts.SyntaxKind.CaseClause,
  ])

/** The loops, every one of which is a structural increment over its own body. */
const LOOP_KINDS = (ts: typeof TS): Set<TS.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
  ])

/** A name for a function that carries none of its own, taken from what holds it. */
const nameHintOf = (node: TS.Node, ts: typeof TS): string | undefined => {
  switch (node.kind) {
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.Parameter: {
      const { name } = node as TS.NamedDeclaration

      return name !== undefined && ts.isIdentifier(name) ? name.text : undefined
    }
    default:
      return undefined
  }
}

const ownNameOf = (node: TS.Node, ts: typeof TS): string | undefined => {
  if (node.kind === ts.SyntaxKind.Constructor) {
    return "constructor"
  }

  if (node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) {
    return "static"
  }

  const { name } = node as TS.NamedDeclaration

  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined
}

/**
 * Lines, as `wc -l` counts them.
 *
 * `getLineStarts` opens one more line after the final newline, which holds
 * nothing. Every file here ends with a newline, so counting line starts
 * would add a phantom line to each one.
 */
const lineCount = (source: string, sourceFile: TS.SourceFile): number => {
  if (source === "") {
    return 0
  }

  const starts = sourceFile.getLineStarts().length

  return source.endsWith("\n") ? starts - 1 : starts
}

/** One open unit, with the nesting level measured from that unit's own start. */
interface Frame {
  /** Index into `units`. */
  unit: number
  nesting: number
}

/** The script kind the parser needs. JSX parses only under TSX or JSX. */
const scriptKindOf = (path: string, ts: typeof TS): TS.ScriptKind => {
  if (path.endsWith(".tsx")) {
    return ts.ScriptKind.TSX
  }

  if (path.endsWith(".jsx")) {
    return ts.ScriptKind.JSX
  }

  if (/\.[mc]?js$/.test(path)) {
    return ts.ScriptKind.JS
  }

  return ts.ScriptKind.TS
}

export const analyze = (
  path: string,
  source: string,
  ts: typeof TS
): FileAnalysis => {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    // No parent pointers: the walk carries its own stack, so they are pure cost.
    false,
    scriptKindOf(path, ts)
  )

  const decisionKinds = DECISION_KINDS(ts)
  const logicalOperators = LOGICAL_OPERATORS(ts)
  const sequenceOperators = SEQUENCE_OPERATORS(ts)
  const loopKinds = LOOP_KINDS(ts)

  const units: Unit[] = []
  let moduleComplexity = 0

  /** Open units, outermost first. Empty means the walk is at module scope. */
  const frames: Frame[] = []
  let moduleNesting = 0
  let cognitiveModule = 0
  let cognitiveTotal = 0

  /** Nodes whose whole subtree sits one level deeper, marked from the parent. */
  const nestingNodes = new Set<TS.Node>()
  /** `if`s that are the `else` of another `if`: a flat +1, and no nesting. */
  const elseIfNodes = new Set<TS.Node>()
  /** Logical expressions already counted as part of a sequence. */
  const consumedLogical = new Set<TS.Node>()

  /**
   * Credits one increment to every open unit, and to the file once.
   *
   * A structural increment costs one plus its depth, and depth is relative:
   * the same `if` is 3 levels down inside the exported handler but 1 level
   * down inside the callback holding it. The file takes the outermost unit's
   * figure, which already includes everything nested below it.
   */
  const addCognitive = (structural: boolean): void => {
    if (frames.length === 0) {
      const amount = structural ? 1 + moduleNesting : 1

      cognitiveModule += amount
      cognitiveTotal += amount

      return
    }

    for (const [index, frame] of frames.entries()) {
      const amount = structural ? 1 + frame.nesting : 1

      ;(units[frame.unit] as Unit).cognitive += amount

      if (index === 0) {
        cognitiveTotal += amount
      }
    }
  }

  const shiftNesting = (by: number): void => {
    moduleNesting += by

    for (const frame of frames) {
      frame.nesting += by
    }
  }

  /** Every operand of one chain of `&&`/`||`, in reading order. */
  const flattenLogical = (node: TS.Node, into: TS.BinaryExpression[]): void => {
    const bare = unwrap(node, ts)

    if (
      !ts.isBinaryExpression(bare) ||
      !sequenceOperators.has(bare.operatorToken.kind)
    ) {
      return
    }

    consumedLogical.add(bare)
    flattenLogical(bare.left, into)
    into.push(bare)
    flattenLogical(bare.right, into)
  }

  /**
   * One increment per run of like operators.
   *
   * `a && b && c` reads as one idea and costs 1. `a && b || c && d` costs 2:
   * every operator change is a place the reader stops to check precedence.
   */
  const visitLogical = (node: TS.BinaryExpression): void => {
    if (consumedLogical.has(node)) {
      return
    }

    const sequence: TS.BinaryExpression[] = []

    flattenLogical(node, sequence)

    let previous: TS.SyntaxKind | undefined

    for (const operand of sequence) {
      if (operand.operatorToken.kind !== previous) {
        addCognitive(false)
      }

      previous = operand.operatorToken.kind
    }
  }

  /** Charge the node, and mark the children that sit one level deeper. */
  const visitCognitive = (node: TS.Node): void => {
    if (ts.isIfStatement(node)) {
      addCognitive(!elseIfNodes.has(node))
      nestingNodes.add(node.thenStatement)

      if (node.elseStatement === undefined) {
        return
      }

      // `else if` is one decision, not two: the reader already paid for the `if`.
      if (ts.isIfStatement(node.elseStatement)) {
        elseIfNodes.add(node.elseStatement)
      } else {
        addCognitive(false)
        nestingNodes.add(node.elseStatement)
      }

      return
    }

    if (loopKinds.has(node.kind)) {
      addCognitive(true)
      nestingNodes.add((node as TS.IterationStatement).statement)

      return
    }

    if (ts.isSwitchStatement(node)) {
      // One increment for the whole statement, however many cases: a switch
      // is read at a glance, unlike an if/else-if chain.
      addCognitive(true)

      for (const clause of node.caseBlock.clauses) {
        nestingNodes.add(clause)
      }

      return
    }

    if (ts.isCatchClause(node)) {
      addCognitive(true)
      nestingNodes.add(node.block)

      return
    }

    if (ts.isConditionalExpression(node)) {
      addCognitive(true)
      nestingNodes.add(node.whenTrue)
      nestingNodes.add(node.whenFalse)

      return
    }

    if (
      (ts.isBreakStatement(node) || ts.isContinueStatement(node)) &&
      node.label !== undefined
    ) {
      // A jump to a label moves the reader elsewhere; a bare `break` or
      // `return` does not, and costs nothing.
      addCognitive(false)

      return
    }

    if (
      ts.isBinaryExpression(node) &&
      sequenceOperators.has(node.operatorToken.kind)
    ) {
      visitLogical(node)
    }
  }

  const decisionDelta = (node: TS.Node): number => {
    if (decisionKinds.has(node.kind)) {
      return 1
    }

    if (
      ts.isBinaryExpression(node) &&
      logicalOperators.has(node.operatorToken.kind)
    ) {
      return 1
    }

    // A default value is an ESTree `AssignmentPattern`, which the rule counts.
    if (
      (ts.isParameter(node) || ts.isBindingElement(node)) &&
      node.initializer !== undefined
    ) {
      return 1
    }

    // Every `?.` in the chain counts, so read the token off the node itself.
    return (
        (node as { questionDotToken?: TS.Node }).questionDotToken !== undefined
      ) ?
        1
      : 0
  }

  const walk = (
    node: TS.Node,
    owner: number,
    hint: string | undefined,
    className: string | undefined
  ): void => {
    const deeper = nestingNodes.has(node)

    // Charges before recursing: `if (a) if (b)` puts the inner `if` one
    // level down, charged 2.
    if (deeper) {
      shiftNesting(1)
    }

    const kind = unitKindOf(node, ts)
    let current = owner
    let opened = false

    if (kind !== undefined) {
      const bare = ownNameOf(node, ts) ?? hint ?? "<anonymous>"
      current = units.length
      units.push({
        name: className === undefined ? bare : `${className}.${bare}`,
        kind,
        line:
          ts.getLineAndCharacterOfPosition(
            sourceFile,
            node.getStart(sourceFile)
          ).line + 1,
        endLine:
          ts.getLineAndCharacterOfPosition(sourceFile, node.getEnd()).line + 1,
        complexity: 1,
        cognitive: 0,
        owner: frames.at(-1)?.unit ?? -1,
      })

      if (opensCognitiveFrame(node, kind, ts)) {
        // A unit inside a unit nests everything above it, and starts its own
        // count at zero.
        for (const frame of frames) {
          frame.nesting += 1
        }

        frames.push({ unit: current, nesting: 0 })
        opened = true
      }
    }

    const delta = decisionDelta(node)

    if (delta > 0) {
      if (current === -1) {
        moduleComplexity += delta
      } else {
        ;(units[current] as Unit).complexity += delta
      }
    }

    visitCognitive(node)

    const childHint =
      nameHintOf(node, ts) ?? (kind === undefined ? hint : undefined)
    const childClass =
      ts.isClassDeclaration(node) || ts.isClassExpression(node) ?
        (node.name?.text ?? className)
      : className

    ts.forEachChild(node, (child) =>
      walk(child, current, childHint, childClass)
    )

    if (opened) {
      frames.pop()

      for (const frame of frames) {
        frame.nesting -= 1
      }
    }

    if (deeper) {
      shiftNesting(-1)
    }
  }

  walk(sourceFile, -1, undefined, undefined)

  const unitTotal = units.reduce((sum, unit) => sum + unit.complexity, 0)
  const topLevel = units.filter((unit) => unit.owner === -1)

  return {
    path,
    lines: lineCount(source, sourceFile),
    units,
    moduleComplexity,
    total: unitTotal + moduleComplexity,
    max: units.reduce((worst, unit) => Math.max(worst, unit.complexity), 0),
    cognitiveModule,
    cognitiveTotal,
    cognitiveMax: topLevel.reduce(
      (worst, unit) => Math.max(worst, unit.cognitive),
      0
    ),
  }
}
