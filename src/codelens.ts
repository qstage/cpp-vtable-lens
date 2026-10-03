import * as vscode from 'vscode';
import { ClassIndex } from './indexer';
import { ClassInfo } from './parser';
import { Abi, ClassLayout, MethodSlot, VTableResolver } from './vtable';

export class VTableLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  private resolver?: VTableResolver;
  private resolverKey = '';

  constructor(private index: ClassIndex) {
    this.onDidChangeCodeLenses = index.onDidChange;
  }

  private pick(name: string, from: ClassInfo): ClassInfo | undefined {
    const c = this.index.find(name).filter(x => x !== from);
    return (
      c.find(x => x.uri === from.uri && x.offset < from.offset) ??
      c.find(x => x.uri === from.uri) ??
      c[0]
    );
  }

  private getResolver(abi: Abi): VTableResolver {
    const key = `${this.index.version}|${abi}`;
    if (!this.resolver || key !== this.resolverKey) {
      this.resolver = new VTableResolver((n, from) => this.pick(n, from), abi);
      this.resolverKey = key;
    }
    return this.resolver;
  }

  async provideCodeLenses(doc: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const cfg = vscode.workspace.getConfiguration('cppVtable');
    if (!cfg.get<boolean>('enabled', true)) return [];

    await this.index.ready;
    if (token.isCancellationRequested) return [];

    this.index.updateDocument(doc, false);
    const resolver = this.getResolver(cfg.get<Abi>('abi', 'msvc'));
    const ptr = cfg.get<number>('pointerSize', 8);
    const showOffset = cfg.get<boolean>('showOffset', false);

    const lenses: vscode.CodeLens[] = [];
    for (const cls of this.index.classesIn(doc.uri.toString())) {
      const L = resolver.layout(cls);
      const polymorphic = L.slots.length > 0 || L.secondary.length > 0;
      if (!polymorphic && L.unresolvedBases.length === 0) continue;

      const clsRange = new vscode.Range(cls.line, 0, cls.line, 0);
      if (polymorphic) {
        lenses.push(new vscode.CodeLens(clsRange, {
          title: classTitle(L),
          tooltip: 'Click to show the full vtable',
          command: 'cppVtable.showVTable',
          arguments: [cls.name, L.slots, ptr],
        }));
      }
      if (L.unresolvedBases.length) {
        lenses.push(new vscode.CodeLens(clsRange, {
          title: `⚠ base not found: ${L.unresolvedBases.join(', ')} (indices may be wrong)`,
          command: '',
        }));
      }

      for (const [m, r] of L.methods) {
        const range = new vscode.Range(m.line, 0, m.line, 0);
        lenses.push(new vscode.CodeLens(range, methodCommand(r, ptr, showOffset)));
      }
    }
    return lenses;
  }
}

function classTitle(L: ClassLayout): string {
  const total = L.slots.length;
  let s = L.inherited > 0
    ? `[${L.inherited} functions inherited from ${L.primaryBase}] · total ${total}`
    : `[vtable: ${total} functions]`;
  if (L.secondary.length) {
    s += ` · +${L.secondary.length} secondary vtable(s): ${L.secondary.map(x => x.name).join(', ')}`;
  }
  return s;
}

function methodCommand(r: MethodSlot, ptr: number, showOffset: boolean): vscode.Command {
  const idx = r.count > 1 ? `${r.index}, ${r.index + 1}` : `${r.index}`;
  const off = showOffset ? ` · +0x${(r.index * ptr).toString(16).toUpperCase()}` : '';

  switch (r.kind) {
    case 'override':
      return {
        title: `[Index ${idx}]${off} overrides ${r.base!.owner}::${r.base!.name}`,
        command: 'cppVtable.goto',
        arguments: [r.base!.uri, r.base!.line],
      };
    case 'secondary':
      return {
        title: `[Index ${idx} in ${r.vtableOf} vtable]${off} overrides ${r.base!.owner}::${r.base!.name}`,
        command: 'cppVtable.goto',
        arguments: [r.base!.uri, r.base!.line],
      };
    default:
      return { title: `[Index ${idx}]${off}${r.warn ? ` ⚠ ${r.warn}` : ''}`, command: '' };
  }
}