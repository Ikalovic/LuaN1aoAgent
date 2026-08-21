import { FofaError } from "./fofa-types.js";

export type FofaQueryNode =
  | {
      kind: "comparison";
      field: string;
      operator: "=" | "!=";
      value: string;
      negated: boolean;
    }
  | { kind: "and" | "or"; children: FofaQueryNode[] };

type Token =
  | { kind: "identifier" | "string"; value: string }
  | { kind: "equals" | "notEquals" | "and" | "or" | "not" | "leftParen" | "rightParen" };

const MAX_QUERY_BYTES = 4_096;
const MAX_TOKENS = 512;
const MAX_NESTING = 32;
const INVALID_QUERY_MESSAGE = "FOFA query contains unsupported or trailing syntax";

export function parseFofaQuery(query: string): FofaQueryNode {
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw invalidQuery();
  }
  const tokens = tokenize(query);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) {
    throw invalidQuery();
  }
  const parser = new Parser(tokens);
  const root = parser.parse();
  if (!parser.atEnd()) {
    throw invalidQuery();
  }
  return root;
}

export function disjunctiveBranches(root: FofaQueryNode): FofaQueryNode[][] {
  if (root.kind === "comparison") {
    return [[root]];
  }
  if (root.kind === "or") {
    const branches = root.children.flatMap(disjunctiveBranches);
    assertBranchBound(branches.length);
    return branches;
  }

  let branches: FofaQueryNode[][] = [[]];
  for (const child of root.children) {
    const childBranches = disjunctiveBranches(child);
    assertBranchBound(branches.length * childBranches.length);
    branches = branches.flatMap((left) => childBranches.map((right) => [...left, ...right]));
  }
  return branches;
}

class Parser {
  private index = 0;
  private nesting = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): FofaQueryNode {
    return this.parseOr();
  }

  atEnd(): boolean {
    return this.index === this.tokens.length;
  }

  private parseOr(): FofaQueryNode {
    let node = this.parseAnd();
    while (this.consume("or")) {
      node = combine("or", node, this.parseAnd());
    }
    return node;
  }

  private parseAnd(): FofaQueryNode {
    let node = this.parseNot();
    while (this.consume("and")) {
      node = combine("and", node, this.parseNot());
    }
    return node;
  }

  private parseNot(): FofaQueryNode {
    if (this.consume("not")) {
      return negate(this.parseNot());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FofaQueryNode {
    if (this.consume("leftParen")) {
      this.nesting += 1;
      if (this.nesting > MAX_NESTING) {
        throw invalidQuery();
      }
      const node = this.parseOr();
      this.expect("rightParen");
      this.nesting -= 1;
      return node;
    }
    return this.parseComparison();
  }

  private parseComparison(): FofaQueryNode {
    const field = this.expectValue("identifier").toLowerCase();
    const operatorToken = this.tokens[this.index];
    if (operatorToken?.kind !== "equals" && operatorToken?.kind !== "notEquals") {
      throw invalidQuery();
    }
    this.index += 1;
    const value = this.expectValue("string");
    return {
      kind: "comparison",
      field,
      operator: operatorToken.kind === "equals" ? "=" : "!=",
      value,
      negated: false
    };
  }

  private consume(kind: Token["kind"]): boolean {
    if (this.tokens[this.index]?.kind !== kind) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(kind: Token["kind"]): void {
    if (!this.consume(kind)) {
      throw invalidQuery();
    }
  }

  private expectValue(kind: "identifier" | "string"): string {
    const token = this.tokens[this.index];
    if (token?.kind !== kind) {
      throw invalidQuery();
    }
    this.index += 1;
    return token.value;
  }
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    const character = query[index];
    if (character === " ") {
      index += 1;
      continue;
    }
    const pair = query.slice(index, index + 2);
    if (pair === "!=") {
      tokens.push({ kind: "notEquals" });
      index += 2;
    } else if (pair === "&&") {
      tokens.push({ kind: "and" });
      index += 2;
    } else if (pair === "||") {
      tokens.push({ kind: "or" });
      index += 2;
    } else if (character === "=") {
      tokens.push({ kind: "equals" });
      index += 1;
    } else if (character === "!") {
      tokens.push({ kind: "not" });
      index += 1;
    } else if (character === "(") {
      tokens.push({ kind: "leftParen" });
      index += 1;
    } else if (character === ")") {
      tokens.push({ kind: "rightParen" });
      index += 1;
    } else if (character === '"') {
      const parsed = readString(query, index + 1);
      tokens.push({ kind: "string", value: parsed.value });
      index = parsed.nextIndex;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(query.slice(index));
      if (!match) {
        throw invalidQuery();
      }
      tokens.push({ kind: "identifier", value: match[0] });
      index += match[0].length;
    }
    if (tokens.length > MAX_TOKENS) {
      throw invalidQuery();
    }
  }
  return tokens;
}

function readString(query: string, startIndex: number): { value: string; nextIndex: number } {
  let value = "";
  let index = startIndex;
  while (index < query.length) {
    const character = query[index];
    if (character === '"') {
      return { value, nextIndex: index + 1 };
    }
    if (character === "\\") {
      index += 1;
      if (index >= query.length) {
        throw invalidQuery();
      }
      value += query[index];
      index += 1;
      continue;
    }
    value += character;
    index += 1;
  }
  throw invalidQuery();
}

function negate(node: FofaQueryNode): FofaQueryNode {
  if (node.kind === "comparison") {
    return { ...node, negated: !node.negated };
  }
  return {
    kind: node.kind === "and" ? "or" : "and",
    children: node.children.map(negate)
  };
}

function combine(kind: "and" | "or", left: FofaQueryNode, right: FofaQueryNode): FofaQueryNode {
  const children: FofaQueryNode[] = [];
  children.push(...(left.kind === kind ? left.children : [left]));
  children.push(...(right.kind === kind ? right.children : [right]));
  return { kind, children };
}

function assertBranchBound(count: number): void {
  if (!Number.isSafeInteger(count) || count > MAX_TOKENS) {
    throw invalidQuery();
  }
}

function invalidQuery(): FofaError {
  return new FofaError("fofa_query_invalid", INVALID_QUERY_MESSAGE);
}
