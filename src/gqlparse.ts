/**
 * gqlparse.ts — a parser for the GraphQL document subset the forge's clients
 * send: named and anonymous operations, variable definitions with defaults,
 * aliases, arguments (variables, scalars, enums, lists, input objects),
 * inline fragments, fragment spreads and directives (parsed, then ignored —
 * the suite's documents use none that change a result).
 */

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

export interface GqlField {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, GqlValue>;
  selectionSet?: GqlSelection[];
}

export type GqlSelection =
  | GqlField
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: GqlSelection[] }
  | { kind: 'fragmentSpread'; name: string };

export interface GqlOperation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: Map<string, { type: string; defaultValue?: GqlValue }>;
  selectionSet: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:@$!|=&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(kind: Token['kind'], value?: string): Token {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, found ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', variableDefinitions: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefinitions = new Map<string, { type: string; defaultValue?: GqlValue }>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expect('punct', '$');
            const varName = this.expect('name').value;
            this.expect('punct', ':');
            const type = this.parseType();
            let defaultValue: GqlValue | undefined;
            if (this.skipPunct('=')) defaultValue = this.parseValue();
            this.skipDirectives();
            variableDefinitions.set(varName, { type, defaultValue });
          }
        }
        this.skipDirectives();
        operations.push({ type: token.value, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${JSON.stringify(token.value)}`);
    }
    return { operations, fragments };
  }

  private parseType(): string {
    let type: string;
    if (this.skipPunct('[')) {
      type = `[${this.parseType()}]`;
      this.expect('punct', ']');
    } else {
      type = this.expect('name').value;
    }
    if (this.skipPunct('!')) type += '!';
    return type;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expect('name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    this.expect('punct', '(');
    while (!this.skipPunct(')')) {
      const name = this.expect('name').value;
      this.expect('punct', ':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, GqlValue>();
      while (!this.skipPunct('}')) {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('punct', '{');
    const selections: GqlSelection[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expect('name').value;
      let alias: string | undefined;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expect('name').value;
      }
      let args = new Map<string, GqlValue>();
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
      this.skipDirectives();
      let selectionSet: GqlSelection[] | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }
}

export function parseGraphQL(source: string): GqlDocument {
  return new Parser(source).parseDocument();
}

/** Turn a parsed value into a plain JS value under the operation's variables. */
export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}
