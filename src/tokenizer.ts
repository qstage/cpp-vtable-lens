export type TokenKind = 'id' | 'num' | 'punct';

export interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

// '<' и '>' намеренно всегда одиночные, чтобы корректно считать вложенность шаблонов (Foo<Bar<int>>)
const PUNCT3 = new Set(['...', '->*']);
const PUNCT2 = new Set([
  '::', '->', '++', '--', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '.*',
]);

const isIdStart = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c > '\x7f';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdPart = (c: string) => isIdStart(c) || isDigit(c);

function skipQuoted(src: string, i: number, raw: boolean): number {
  const n = src.length;
  const q = src[i];
  if (raw && q === '"') {
    const paren = src.indexOf('(', i + 1);
    if (paren < 0) return n;
    const delim = src.slice(i + 1, paren);
    const end = src.indexOf(')' + delim + '"', paren + 1);
    return end < 0 ? n : end + delim.length + 2;
  }
  i++;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    if (c === '\n') return i; // незакрытая строка
    i++;
  }
  return n;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  let atLineStart = true;

  while (i < n) {
    const c = src[i];

    if (c === '\n') { atLineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }

    // комментарии
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }

    // директивы препроцессора (с учётом переноса строки через '\')
    if (c === '#' && atLineStart) {
      while (i < n) {
        if (src[i] === '\n') {
          let k = i - 1;
          if (src[k] === '\r') k--;
          if (src[k] === '\\') { i++; continue; }
          break;
        }
        if (src[i] === '/' && src[i + 1] === '*') {
          const e = src.indexOf('*/', i + 2);
          i = e < 0 ? n : e + 2;
          continue;
        }
        if (src[i] === '/' && src[i + 1] === '/') {
          while (i < n && src[i] !== '\n') i++;
          break;
        }
        i++;
      }
      continue;
    }

    atLineStart = false;

    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      const word = src.slice(i, j);
      // строковые префиксы: L"", u8"", R"(...)", LR"(...)" ...
      if ((src[j] === '"' || src[j] === "'") && /^(?:L|u8|u|U)?R?$/.test(word)) {
        i = skipQuoted(src, j, word.endsWith('R'));
        continue;
      }
      out.push({ kind: 'id', value: word, start: i, end: j });
      i = j;
      continue;
    }

    if (c === '"' || c === "'") { i = skipQuoted(src, i, false); continue; }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n) {
        const d = src[j];
        if (isIdPart(d) || d === '.') { j++; continue; }
        if (d === "'" && isIdPart(src[j + 1] ?? '')) { j++; continue; } // 1'000'000
        if ((d === '+' || d === '-') && /[eEpP]/.test(src[j - 1])) { j++; continue; }
        break;
      }
      out.push({ kind: 'num', value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    const p3 = src.substr(i, 3);
    if (PUNCT3.has(p3)) { out.push({ kind: 'punct', value: p3, start: i, end: i + 3 }); i += 3; continue; }
    const p2 = src.substr(i, 2);
    if (PUNCT2.has(p2)) { out.push({ kind: 'punct', value: p2, start: i, end: i + 2 }); i += 2; continue; }
    out.push({ kind: 'punct', value: c, start: i, end: i + 1 });
    i++;
  }
  return out;
}

export function joinTokens(toks: Token[]): string {
  let s = '';
  let prev: Token | undefined;
  for (const t of toks) {
    if (prev && prev.kind !== 'punct' && t.kind !== 'punct') s += ' ';
    s += t.value;
    prev = t;
  }
  return s;
}