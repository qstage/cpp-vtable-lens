import { Token, tokenize, joinTokens } from './tokenizer';

export interface ParseOptions {
  classKeywords: Set<string>;
  ignoredMacros: Set<string>;
  overrideMacros: Set<string>;
}

export interface MethodInfo {
  name: string;
  /** ключ для сопоставления override: имя + нормализованные типы параметров + cv */
  key: string;
  display: string;
  isVirtual: boolean;
  isOverride: boolean;
  isDestructor: boolean;
  isPure: boolean;
  line: number;
}

export interface BaseSpec {
  name: string;      // простое имя для поиска (без namespace и шаблонных аргументов)
  fullName: string;  // как написано в исходнике
  access: string;
  isVirtual: boolean;
}

export interface ClassInfo {
  name: string;
  uri: string;
  line: number;
  offset: number;
  bases: BaseSpec[];
  methods: MethodInfo[];
}

const ACCESS = new Set(['public', 'private', 'protected']);
const QT_ACCESS = new Set(['signals', 'slots', 'Q_SIGNALS', 'Q_SLOTS']);
const TYPE_KEYWORDS = new Set([
  'void', 'bool', 'char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'short', 'int', 'long',
  'float', 'double', 'signed', 'unsigned', 'auto', '__int8', '__int16', '__int32', '__int64', '__int128',
]);
const NON_TYPE_PREFIX = new Set(['const', 'volatile', 'struct', 'class', 'enum', 'union', 'typename', 'register']);
const SKIP_STATEMENT = new Set(['typedef', 'using', 'friend', 'static_assert', 'template', 'namespace']);

interface Ctx {
  toks: Token[];
  match: Int32Array;
  lines: number[];
  opts: ParseOptions;
  className: string;
}

function matchBrackets(toks: Token[]): Int32Array {
  const m = new Int32Array(toks.length).fill(-1);
  const stacks = new Map<string, number[]>([['(', []], ['[', []], ['{', []]]);
  const pair = new Map([[')', '('], [']', '['], ['}', '{']]);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'punct') continue;
    const st = stacks.get(t.value);
    if (st) { st.push(i); continue; }
    const open = pair.get(t.value);
    if (open) {
      const o = stacks.get(open)!.pop();
      if (o !== undefined) { m[o] = i; m[i] = o; }
    }
  }
  return m;
}

function buildLineStarts(text: string): number[] {
  const a = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) a.push(i + 1);
  return a;
}

function lineAt(starts: number[], off: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function skipAngles(toks: Token[], j: number, match: Int32Array): number {
  let depth = 0;
  for (; j < toks.length; j++) {
    const v = toks[j].value;
    if (v === '(' || v === '[') { const c = match[j]; if (c < 0) return -1; j = c; continue; }
    if (v === '<') depth++;
    else if (v === '>') { depth--; if (depth === 0) return j + 1; }
    else if (v === ';' || v === '{' || v === '}') return -1;
  }
  return -1;
}

function makeBase(tokens: Token[]): BaseSpec | undefined {
  let access = '';
  let isVirtual = false;
  const rest: Token[] = [];
  for (const t of tokens) {
    if (rest.length === 0 && ACCESS.has(t.value)) { access = t.value; continue; }
    if (rest.length === 0 && t.value === 'virtual') { isVirtual = true; continue; }
    rest.push(t);
  }
  let name = '';
  for (const t of rest) {
    if (t.value === '<') break;
    if (t.kind === 'id') name = t.value;
  }
  if (!name) return undefined;
  return { name, fullName: joinTokens(rest), access, isVirtual };
}

interface ClassHead { name: string; bases: BaseSpec[]; bodyOpen: number; }

function parseClassHead(toks: Token[], j: number, match: Int32Array): ClassHead | undefined {
  let name = '';
  let nameTok = -1;

  while (j < toks.length) {
    const tk = toks[j];
    if (tk.kind === 'id') {
      if (nameTok >= 0 && (tk.value === 'final' || tk.value === 'sealed' || tk.value === 'abstract')) { j++; continue; }
      // макрос с аргументами: __declspec(novtable), alignas(16) ...
      if (toks[j + 1]?.value === '(') {
        const c = match[j + 1];
        if (c < 0) return undefined;
        j = c + 1;
        continue;
      }
      // последний идентификатор — имя (DLL_EXPORT Foo -> Foo), поддержка A::B
      name = tk.value; nameTok = j; j++;
      while (toks[j]?.value === '::' && toks[j + 1]?.kind === 'id') {
        name = toks[j + 1].value; nameTok = j + 1; j += 2;
      }
      continue;
    }
    if (tk.value === '[') { const c = match[j]; if (c < 0) return undefined; j = c + 1; continue; } // [[attr]]
    if (tk.value === '<' && nameTok >= 0) { j = skipAngles(toks, j, match); if (j < 0) return undefined; continue; }
    break;
  }

  const stop = toks[j];
  if (!stop || nameTok < 0) return undefined;
  const bases: BaseSpec[] = [];
  if (stop.value === '{') return { name, bases, bodyOpen: j };
  if (stop.value !== ':') return undefined;

  let cur: Token[] = [];
  let depth = 0;
  for (let k = j + 1; k < toks.length; k++) {
    const v = toks[k].value;
    if (v === '(') {
      const c = match[k];
      if (c < 0) return undefined;
      cur.push(...toks.slice(k, c + 1));
      k = c;
      continue;
    }
    if (v === '<') depth++;
    else if (v === '>') depth--;
    else if (depth <= 0) {
      if (v === '{') {
        const b = makeBase(cur);
        if (b) bases.push(b);
        return { name, bases, bodyOpen: k };
      }
      if (v === ';' || v === '}') return undefined;
      if (v === ',') {
        const b = makeBase(cur);
        if (b) bases.push(b);
        cur = [];
        continue;
      }
    }
    cur.push(toks[k]);
  }
  return undefined;
}

function normalizeParam(p: Token[]): string {
  // отбросить значение по умолчанию
  let angle = 0, cut = p.length;
  for (let i = 0; i < p.length; i++) {
    const v = p[i].value;
    if (v === '<') angle++;
    else if (v === '>') angle--;
    else if (v === '=' && angle <= 0) { cut = i; break; }
  }
  let t = p.slice(0, cut);

  // массивы: int a[10] -> int[]
  let arr = '';
  while (t.length && t[t.length - 1].value === ']') {
    let o = t.length - 1;
    while (o >= 0 && t[o].value !== '[') o--;
    if (o < 0) break;
    t = t.slice(0, o);
    arr += '[]';
  }

  // отбросить имя параметра
  if (t.length >= 2) {
    const last = t[t.length - 1];
    const prev = t[t.length - 2];
    if (
      last.kind === 'id' &&
      !TYPE_KEYWORDS.has(last.value) &&
      !NON_TYPE_PREFIX.has(last.value) &&
      prev.value !== '::' &&
      t.slice(0, -1).some(x => x.kind === 'id' && !NON_TYPE_PREFIX.has(x.value))
    ) {
      t = t.slice(0, -1);
    }
  }
  return joinTokens(t) + arr;
}

function normalizeParams(toks: Token[], from: number, to: number, match: Int32Array): string[] {
  const groups: Token[][] = [];
  let cur: Token[] = [];
  let angle = 0;
  for (let k = from; k < to; k++) {
    const v = toks[k].value;
    if (v === '(' || v === '[' || v === '{') {
      const c = match[k];
      const end = c < 0 || c >= to ? to - 1 : c;
      cur.push(...toks.slice(k, end + 1));
      k = end;
      continue;
    }
    if (v === '<') angle++;
    else if (v === '>' && angle > 0) angle--;
    if (v === ',' && angle === 0) { groups.push(cur); cur = []; continue; }
    cur.push(toks[k]);
  }
  if (cur.length) groups.push(cur);
  const res = groups.map(normalizeParam).filter(x => x.length > 0);
  if (res.length === 1 && res[0] === 'void') return [];
  return res;
}

function analyzeDecl(ctx: Ctx, s: number, e: number, depth: number): MethodInfo | undefined {
  const { toks, match, opts } = ctx;
  if (depth > 8) return undefined;

  while (s < e && toks[s].value === '[') { // [[nodiscard]] ...
    const c = match[s];
    if (c < 0 || c >= e) return undefined;
    s = c + 1;
  }
  if (s >= e || SKIP_STATEMENT.has(toks[s].value)) return undefined;

  let isVirtual = false, isStatic = false, isDtor = false;
  let name = '';
  let open = -1;

  for (let k = s; k < e && open < 0; k++) {
    const t = toks[k], v = t.value;
    if (v === 'virtual') { isVirtual = true; continue; }
    if (v === 'static') { isStatic = true; continue; }
    if (v === '=') return undefined; // поле с инициализатором
    if (v === '[') { const c = match[k]; if (c < 0) return undefined; k = c; continue; }
    if (v === 'operator') {
      let q = k + 1;
      if (toks[q]?.value === '(' && toks[q + 1]?.value === ')') { name = 'operator()'; q += 2; }
      else {
        const parts: Token[] = [];
        while (q < e && toks[q].value !== '(') parts.push(toks[q++]);
        name = 'operator' + (parts[0]?.kind === 'id' ? ' ' : '') + joinTokens(parts);
      }
      if (q >= e || toks[q].value !== '(') return undefined;
      open = q;
      break;
    }
    if (v === '(') {
      const c = match[k];
      if (c < 0) return undefined;
      const prev = toks[k - 1];
      if (
        k > s && prev.kind === 'id' &&
        !TYPE_KEYWORDS.has(prev.value) &&
        !NON_TYPE_PREFIX.has(prev.value) &&
        !opts.ignoredMacros.has(prev.value)
      ) {
        open = k;
        name = prev.value;
        if (k - 2 >= s && toks[k - 2].value === '~') { isDtor = true; name = '~' + name; }
        break;
      }
      k = c;
    }
  }
  if (open < 0) return undefined;
  const close = match[open];
  if (close < 0 || close >= e) return undefined;

  // квалификаторы после списка параметров
  let cv = '', isOverride = false, isPure = false;
  for (let k = close + 1; k < e; k++) {
    const t = toks[k], v = t.value;
    const next = toks[k + 1]?.value;
    if (v === '=') { isPure = next === '0'; break; }
    if (v === '->' || v === ':') break;
    if (v === 'const' || v === 'volatile' || v === '&' || v === '&&') { cv += ' ' + v; continue; }
    if (v === 'override' || opts.overrideMacros.has(v)) { isOverride = true; continue; }
    if (v === 'final') { isVirtual = true; continue; }
    if (v === '[') { const c = match[k]; if (c < 0) return undefined; k = c; continue; }
    if (next === '(' && (v === 'noexcept' || v === 'throw' || v === '__attribute__' || v === '__declspec' || opts.ignoredMacros.has(v))) {
      const c = match[k + 1];
      if (c < 0) return undefined;
      k = c;
      continue;
    }
    // "MACRO(args) virtual void Foo();" — то, что мы приняли за функцию, было макросом
    if (v === 'virtual' || TYPE_KEYWORDS.has(v) || (t.kind === 'id' && next === '(')) {
      return analyzeDecl(ctx, close + 1, e, depth + 1);
    }
  }

  if (!isDtor && name === ctx.className) return undefined; // конструктор
  if (isStatic) return undefined;

  const params = normalizeParams(toks, open + 1, close, match);
  const display = `${name}(${params.join(', ')})${cv}`;
  return {
    name,
    key: isDtor ? '~' : display,
    display,
    isVirtual,
    isOverride,
    isDestructor: isDtor,
    isPure,
    line: lineAt(ctx.lines, toks[s].start),
  };
}

function parseMembers(ctx: Ctx, from: number, to: number): MethodInfo[] {
  const { toks, match, opts } = ctx;
  const out: MethodInfo[] = [];
  const isTypeKw = (v: string) => v === 'enum' || v === 'union' || opts.classKeywords.has(v);

  let stmt = from, k = from, stmtIsType = false;
  const endStmt = (next: number) => { stmt = next; k = next; stmtIsType = false; };

  while (k < to) {
    const t = toks[k], v = t.value;

    // public: / protected: / public slots:
    if (k === stmt && t.kind === 'id' && (ACCESS.has(v) || QT_ACCESS.has(v))) {
      let a = k + 1;
      while (a < to && toks[a].kind === 'id' && a - k < 3) a++;
      if (a < to && toks[a].value === ':') { endStmt(a + 1); continue; }
    }

    if (v === '(' || v === '[') {
      const c = match[k];
      k = c < 0 ? to : c + 1;
      continue;
    }

    if (v === '{') {
      const c = match[k];
      const close = c < 0 || c > to ? to : c;
      let hasParen = false, hasType = false;
      for (let q = stmt; q < k; q++) {
        const qv = toks[q].value;
        if (qv === '(') hasParen = true;
        else if (isTypeKw(qv)) hasType = true;
      }
      if (hasType && !hasParen) { // вложенный тип: оператор продолжается до ';'
        stmtIsType = true;
        k = close + 1;
        continue;
      }
      if (hasParen && !stmtIsType) { // inline-тело функции
        const m = analyzeDecl(ctx, stmt, k, 0);
        if (m) out.push(m);
      }
      endStmt(close + 1);
      continue;
    }

    if (v === ';') {
      if (!stmtIsType) {
        const m = analyzeDecl(ctx, stmt, k, 0);
        if (m) out.push(m);
      }
      endStmt(k + 1);
      continue;
    }
    k++;
  }
  return out;
}

export function parseClasses(text: string, uri: string, opts: ParseOptions): ClassInfo[] {
  const toks = tokenize(text);
  const match = matchBrackets(toks);
  const lines = buildLineStarts(text);
  const result: ClassInfo[] = [];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'id' || !opts.classKeywords.has(t.value)) continue;
    const prev = toks[i - 1]?.value;
    // enum class, friend class, template<class T, class U>
    if (prev === 'enum' || prev === 'friend' || prev === '<' || prev === ',' || prev === '(') continue;

    const head = parseClassHead(toks, i + 1, match);
    if (!head) continue;
    const close = match[head.bodyOpen];
    if (close < 0) continue;

    const ctx: Ctx = { toks, match, lines, opts, className: head.name };
    result.push({
      name: head.name,
      uri,
      line: lineAt(lines, t.start),
      offset: t.start,
      bases: head.bases,
      methods: parseMembers(ctx, head.bodyOpen + 1, close),
    });
  }
  return result;
}