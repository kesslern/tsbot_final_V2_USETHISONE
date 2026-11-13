// Evaluates arithmetic expressions without eval(), so anything typed in IRC is safe to pass in.
// Supports + - * / % ^ (power), parentheses, constants pi and e, and the functions below.

const functions: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow,
};
const constants: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { type: 'number'; value: number } | { type: 'name'; value: string } | { type: 'op'; value: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*)|(\*\*|[-+*/%^(),]))/iy;
  let index = 0;
  while (index < expression.length) {
    if (/^\s*$/.test(expression.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`Unexpected character at position ${index + 1}: "${expression.slice(index).trim()[0]}"`);
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'name', value: match[2].toLowerCase() });
    else tokens.push({ type: 'op', value: match[3] === '**' ? '^' : match[3] });
  }
  return tokens;
}

export function calculate(expression: string): number {
  if (expression.length > 500) throw new Error('Expression is too long.');
  const tokens = tokenize(expression);
  let position = 0;

  const peek = () => tokens[position];
  const isOp = (value: string) => peek()?.type === 'op' && peek()!.value === value;
  const expect = (value: string) => {
    if (!isOp(value)) throw new Error(`Expected "${value}"`);
    position++;
  };

  // expression := term (('+' | '-') term)*
  function parseExpression(): number {
    let value = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = tokens[position++].value;
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  // term := unary (('*' | '/' | '%') unary)*
  function parseTerm(): number {
    let value = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[position++].value;
      const right = parseUnary();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  // unary := ('-' | '+') unary | power
  function parseUnary(): number {
    if (isOp('-')) { position++; return -parseUnary(); }
    if (isOp('+')) { position++; return parseUnary(); }
    return parsePower();
  }

  // power := primary ('^' unary)?   (right-associative, so 2^3^2 = 2^9)
  function parsePower(): number {
    const base = parsePrimary();
    if (isOp('^')) { position++; return base ** parseUnary(); }
    return base;
  }

  // primary := number | constant | function '(' args ')' | '(' expression ')'
  function parsePrimary(): number {
    const token = tokens[position++];
    if (!token) throw new Error('Unexpected end of expression');
    if (token.type === 'number') return token.value;
    if (token.type === 'op' && token.value === '(') {
      const value = parseExpression();
      expect(')');
      return value;
    }
    if (token.type === 'name') {
      if (Object.hasOwn(constants, token.value) && !isOp('(')) return constants[token.value];
      const fn = Object.hasOwn(functions, token.value) ? functions[token.value] : undefined;
      if (!fn) throw new Error(`Unknown name "${token.value}"`);
      expect('(');
      const args = [parseExpression()];
      while (isOp(',')) { position++; args.push(parseExpression()); }
      expect(')');
      return fn(...args);
    }
    throw new Error(`Unexpected "${token.value}"`);
  }

  const result = parseExpression();
  if (position < tokens.length) throw new Error(`Unexpected "${tokens[position].value}"`);
  if (!Number.isFinite(result)) throw new Error('The result is not a finite number.');
  return result;
}
