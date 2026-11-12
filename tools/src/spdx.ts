/*
 * A reader for SPDX license expressions, as found in a package.json "license" field. It answers
 * one question: is every obligation of this expression covered by a list of license ids Pinwall
 * accepts? `OR` is satisfied by either side, `AND` needs both, and `WITH <exception>` is judged
 * by its base license. Anything that is not an expression is not satisfied.
 */

type Expression =
  | { kind: 'id'; id: string }
  | { kind: 'and' | 'or'; left: Expression; right: Expression };

/** A word of an expression, or a parenthesis. */
const TOKEN = /[()]|[^\s()]+/g;
/** A license or exception id, a `LicenseRef-`, or a `DocumentRef-x:LicenseRef-y`. */
const ID = /^[A-Za-z0-9.+:-]+$/;

class Parser {
  private position = 0;

  constructor(private readonly tokens: string[]) {}

  parse(): Expression {
    const expression = this.parseOr();
    if (this.position < this.tokens.length) throw new Error(`unexpected "${this.peek()}"`);
    return expression;
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private next(): string {
    const token = this.tokens[this.position++];
    if (token === undefined) throw new Error('the expression ends too soon');
    return token;
  }

  private isOperator(word: 'AND' | 'OR' | 'WITH'): boolean {
    return this.peek()?.toUpperCase() === word;
  }

  /** `or` binds loosest, then `and`, then `with`. */
  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.isOperator('OR')) {
      this.next();
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseWith();
    while (this.isOperator('AND')) {
      this.next();
      left = { kind: 'and', left, right: this.parseWith() };
    }
    return left;
  }

  private parseWith(): Expression {
    const license = this.parsePrimary();
    if (this.isOperator('WITH')) {
      this.next();
      this.expectId(); // the exception's own id; the license it modifies decides
    }
    return license;
  }

  private parsePrimary(): Expression {
    if (this.peek() === '(') {
      this.next();
      const inner = this.parseOr();
      if (this.next() !== ')') throw new Error('a parenthesis is not closed');
      return inner;
    }
    // A trailing "+" means "or any later version"; the base license is what is judged.
    return { kind: 'id', id: this.expectId().replace(/\+$/, '') };
  }

  private expectId(): string {
    const token = this.next();
    if (!ID.test(token) || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
      throw new Error(`"${token}" is not a license id`);
    }
    return token;
  }
}

function holds(expression: Expression, allowed: ReadonlySet<string>): boolean {
  switch (expression.kind) {
    case 'id':
      return allowed.has(expression.id.toLowerCase());
    case 'and':
      return holds(expression.left, allowed) && holds(expression.right, allowed);
    case 'or':
      return holds(expression.left, allowed) || holds(expression.right, allowed);
  }
}

/**
 * Whether `expression` is covered by `allowed` (license ids, compared without regard to case).
 * An empty, unparsable or "UNLICENSED" / "SEE LICENSE IN …" value is not covered.
 */
export function satisfiesLicense(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = expression.match(TOKEN) ?? [];
  if (tokens.length === 0) return false;
  let parsed: Expression;
  try {
    parsed = new Parser(tokens).parse();
  } catch {
    return false;
  }
  return holds(parsed, new Set([...allowed].map((id) => id.toLowerCase())));
}
