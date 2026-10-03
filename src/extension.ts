import * as vscode from 'vscode';
import { ClassIndex, isCppDocument } from './indexer';
import { VTableLensProvider } from './codelens';
import { ParseOptions } from './parser';
import { Slot } from './vtable';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'cpp' },
  { language: 'c' },
  { language: 'cuda-cpp' },
  { scheme: 'file', pattern: '**/*.{h,hh,hpp,hxx,inl,ipp,tpp,cpp,cc,cxx}' },
];

function readParseOptions(): ParseOptions {
  const cfg = vscode.workspace.getConfiguration('cppVtable');
  return {
    classKeywords: new Set(cfg.get<string[]>('classKeywords', ['class', 'struct', 'abstract_class'])),
    ignoredMacros: new Set(cfg.get<string[]>('ignoredMacros', ['__declspec', '__attribute__', 'alignas'])),
    overrideMacros: new Set(cfg.get<string[]>('overrideMacros', ['OVERRIDE'])),
  };
}

async function gotoLocation(uri: string, line: number) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const pos = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
}

export function activate(context: vscode.ExtensionContext) {
  const index = new ClassIndex(readParseOptions);
  index.rebuild();

  const provider = new VTableLensProvider(index);
  context.subscriptions.push(index, vscode.languages.registerCodeLensProvider(SELECTOR, provider));

  // правки в редакторе (debounce) — пересчитываем, в т.ч. наследников в других файлах
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!isCppDocument(e.document) || e.contentChanges.length === 0) return;
      const key = e.document.uri.toString();
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        index.updateDocument(e.document, false);
        index.notify();
      }, 400));
    }),
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (isCppDocument(doc)) index.updateDocument(doc, true);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      // несохранённые изменения отброшены — перечитываем с диска
      if (isCppDocument(doc) && doc.uri.scheme === 'file') index.updateFile(doc.uri, true);
    }),
  );

  // изменения файлов на диске (git checkout, генерация и т.п.)
  const include = vscode.workspace.getConfiguration('cppVtable')
    .get<string>('include', '**/*.{h,hh,hpp,hxx,inl,ipp,tpp,cpp,cc,cxx}');
  const watcher = vscode.workspace.createFileSystemWatcher(include);
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(u => index.updateFile(u)),
    watcher.onDidChange(u => index.updateFile(u)),
    watcher.onDidDelete(u => index.remove(u)),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('cppVtable')) return;
      const reparse = ['classKeywords', 'ignoredMacros', 'overrideMacros', 'include', 'exclude', 'maxFileSizeKB']
        .some(k => e.affectsConfiguration(`cppVtable.${k}`));
      if (reparse) index.rebuild();
      else index.invalidate(true);
    }),

    vscode.commands.registerCommand('cppVtable.reindex', () => index.rebuild()),

    vscode.commands.registerCommand('cppVtable.goto', (uri: string, line: number) => gotoLocation(uri, line)),

    vscode.commands.registerCommand('cppVtable.showVTable', async (className?: string, slots?: Slot[], ptr = 8) => {
      if (!className || !slots) {
        vscode.window.showInformationMessage('Click the lens above a class to see its vtable.');
        return;
      }
      const items = slots.map((s, i) => ({
        label: `[${i}] ${s.display}`,
        description: s.owner,
        detail: `offset +0x${(i * ptr).toString(16).toUpperCase()}`,
        slot: s,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: `VTable of ${className} — ${slots.length} slots`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (picked) await gotoLocation(picked.slot.uri, picked.slot.line);
    }),
  );
}

export function deactivate() {}