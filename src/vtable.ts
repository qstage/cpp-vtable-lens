import { ClassInfo, MethodInfo } from './parser';

export type Abi = 'msvc' | 'itanium';

export interface Slot {
  key: string;
  name: string;
  display: string;
  owner: string;
  uri: string;
  line: number;
  isDestructor: boolean;
}

export interface MethodSlot {
  index: number;
  count: number;                       // деструктор в Itanium занимает 2 слота
  kind: 'new' | 'override' | 'secondary';
  base?: Slot;                         // переопределяемый слот
  vtableOf?: string;                   // для secondary: из какой базы vtable
  warn?: string;
}

export interface ClassLayout {
  cls: ClassInfo;
  slots: Slot[];
  inherited: number;
  primaryBase?: string;
  secondary: { name: string; layout: ClassLayout }[];
  unresolvedBases: string[];
  methods: Map<MethodInfo, MethodSlot>;
}

export class VTableResolver {
  private cache = new Map<ClassInfo, ClassLayout>();

  constructor(
    private find: (name: string, from: ClassInfo) => ClassInfo | undefined,
    private abi: Abi,
  ) {}

  layout(cls: ClassInfo, stack = new Set<ClassInfo>()): ClassLayout {
    const cached = this.cache.get(cls);
    if (cached) return cached;

    const L: ClassLayout = {
      cls, slots: [], inherited: 0, secondary: [], unresolvedBases: [], methods: new Map(),
    };
    if (stack.has(cls)) return L; // защита от циклов
    stack.add(cls);

    // primary base — первая невиртуальная база с vtable, остальные — вторичные vtable
    let primary: ClassLayout | undefined;
    for (const b of cls.bases) {
      const bc = this.find(b.name, cls);
      if (!bc) { L.unresolvedBases.push(b.fullName); continue; }
      const bl = this.layout(bc, stack);
      if (!primary && !b.isVirtual && bl.slots.length > 0) {
        primary = bl;
        L.primaryBase = b.fullName;
      } else if (bl.slots.length > 0 || bl.secondary.length > 0) {
        L.secondary.push({ name: b.fullName, layout: bl });
      }
    }
    stack.delete(cls);
    if (primary) L.secondary.unshift(...primary.secondary);

    const dtorCount = this.abi === 'itanium' ? 2 : 1;
    const slots: Slot[] = primary ? primary.slots.slice() : [];
    L.inherited = slots.length;

    const mkSlot = (m: MethodInfo): Slot => ({
      key: m.key, name: m.name, display: m.display, owner: cls.name,
      uri: cls.uri, line: m.line, isDestructor: m.isDestructor,
    });

    const findSecondary = (pred: (s: Slot) => boolean) => {
      for (const s of L.secondary) {
        const i = s.layout.slots.findIndex(pred);
        if (i >= 0) return { name: s.name, index: i, slot: s.layout.slots[i] };
      }
      return undefined;
    };

    const fresh: MethodInfo[] = [];
    for (const m of cls.methods) {
      const pred = m.isDestructor ? (s: Slot) => s.isDestructor : (s: Slot) => s.key === m.key;

      const idx = slots.findIndex(pred);
      if (idx >= 0) {
        const count = m.isDestructor ? dtorCount : 1;
        L.methods.set(m, { index: idx, count, kind: 'override', base: slots[idx] });
        for (let p = 0; p < count && idx + p < slots.length; p++) slots[idx + p] = mkSlot(m);
        continue;
      }

      const sec = findSecondary(pred);
      if (sec) {
        L.methods.set(m, { index: sec.index, count: 1, kind: 'secondary', base: sec.slot, vtableOf: sec.name });
        continue;
      }

      if (m.isVirtual || m.isOverride) fresh.push(m);
    }

    // MSVC: перегрузки одной функции группируются в месте первого объявления
    // и располагаются в обратном порядке
    let ordered = fresh;
    if (this.abi === 'msvc') {
      const groups = new Map<string, MethodInfo[]>();
      for (const m of fresh) {
        const g = groups.get(m.name);
        if (g) g.push(m); else groups.set(m.name, [m]);
      }
      ordered = [];
      for (const g of groups.values()) ordered.push(...g.slice().reverse());
    }

    for (const m of ordered) {
      const count = m.isDestructor ? dtorCount : 1;
      const r: MethodSlot = { index: slots.length, count, kind: 'new' };
      if (m.isOverride && !m.isVirtual) {
        r.warn = L.unresolvedBases.length ? 'base class not indexed' : 'base function not found';
      }
      L.methods.set(m, r);
      for (let p = 0; p < count; p++) slots.push(mkSlot(m));
    }

    L.slots = slots;
    this.cache.set(cls, L);
    return L;
  }
}