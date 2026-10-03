import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { ClassInfo, ParseOptions, parseClasses } from './parser';

const CPP_EXT = /\.(h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|cpp|cc|cxx|c\+\+)$/i;
const CPP_LANGS = new Set(['cpp', 'c', 'cuda-cpp', 'objective-cpp']);

export function isCppDocument(doc: vscode.TextDocument): boolean {
  return CPP_LANGS.has(doc.languageId) || CPP_EXT.test(doc.fileName);
}

export class ClassIndex implements vscode.Disposable {
  private files = new Map<string, ClassInfo[]>();
  private byName: Map<string, ClassInfo[]> | undefined;
  private docVersions = new Map<string, number>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  version = 0;
  ready: Promise<void> = Promise.resolve();

  constructor(private getOptions: () => ParseOptions) {}

  rebuild(): Promise<void> {
    // withProgress возвращает Thenable, оборачиваем в Promise для совместимости типов
    this.ready = Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'C++ VTable: indexing…' },
        () => this.scanWorkspace(),
      ),
    );
    return this.ready;
  }

  private async scanWorkspace(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('cppVtable');
    const include = cfg.get<string>('include', '**/*.{h,hh,hpp,hxx,inl,ipp,tpp,cpp,cc,cxx}');
    const exclude = cfg.get<string>('exclude', '**/{node_modules,.git,build,out,bin,obj}/**');
    const maxBytes = cfg.get<number>('maxFileSizeKB', 2048) * 1024;
    const opts = this.getOptions();
    const decoder = new TextDecoder('utf-8');

    this.files.clear();
    this.docVersions.clear();

    const uris = await vscode.workspace.findFiles(include, exclude);
    const BATCH = 32;
    for (let i = 0; i < uris.length; i += BATCH) {
      await Promise.all(uris.slice(i, i + BATCH).map(async uri => {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > maxBytes) return;
          const data = await vscode.workspace.fs.readFile(uri);
          this.files.set(uri.toString(), parseClasses(decoder.decode(data), uri.toString(), opts));
        } catch {
          /* ignore unreadable files */
        }
      }));
    }

    // открытые документы могут содержать несохранённые изменения
    for (const doc of vscode.workspace.textDocuments) {
      if (isCppDocument(doc)) this.setDocument(doc, opts);
    }
    this.invalidate(true);
  }

  private setDocument(doc: vscode.TextDocument, opts = this.getOptions()) {
    const key = doc.uri.toString();
    this.files.set(key, parseClasses(doc.getText(), key, opts));
    this.docVersions.set(key, doc.version);
  }

  /** @returns true если документ был переразобран */
  updateDocument(doc: vscode.TextDocument, fire: boolean): boolean {
    const key = doc.uri.toString();
    if (this.docVersions.get(key) === doc.version && this.files.has(key)) return false;
    this.setDocument(doc);
    this.invalidate(fire);
    return true;
  }

  async updateFile(uri: vscode.Uri, force = false): Promise<void> {
    const key = uri.toString();
    if (!force && vscode.workspace.textDocuments.some(d => d.uri.toString() === key)) return;
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      this.files.set(key, parseClasses(new TextDecoder('utf-8').decode(data), key, this.getOptions()));
      this.docVersions.delete(key);
      this.invalidate(true);
    } catch {
      this.remove(uri);
    }
  }

  remove(uri: vscode.Uri) {
    const key = uri.toString();
    if (this.files.delete(key)) {
      this.docVersions.delete(key);
      this.invalidate(true);
    }
  }

  invalidate(fire: boolean) {
    this.byName = undefined;
    this.version++;
    if (fire) this.emitter.fire();
  }

  notify() { this.emitter.fire(); }

  classesIn(uri: string): ClassInfo[] {
    return this.files.get(uri) ?? [];
  }

  find(name: string): ClassInfo[] {
    if (!this.byName) {
      this.byName = new Map();
      for (const list of this.files.values()) {
        for (const c of list) {
          const arr = this.byName.get(c.name);
          if (arr) arr.push(c); else this.byName.set(c.name, [c]);
        }
      }
    }
    return this.byName.get(name) ?? [];
  }

  dispose() { this.emitter.dispose(); }
}