import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
  SymbolKind, CompletionItemKind, ResponseError, ErrorCodes,
  DidChangeWatchedFilesNotification } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { open, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AnalyzerWorker } from './worker-client.js';
import { formatBend } from '../vendor/formatter.js';
import { KEYWORDS } from '../vendor/bend.js';
import type { Analysis, Source, Span, Symbol as SemanticSymbol } from './model.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const worker = new AnalyzerWorker();
let roots: string[] = [];
let epoch = 0;
let stopped = false;
let timer: NodeJS.Timeout | undefined;
let cached: { epoch: number; value: Index } | undefined;
let pending: { epoch: number; promise: Promise<Index> } | undefined;
let published = new Set<string>();
let lastWarning = '';
let canWatch = false;
let canChangeFolders = false;
type Index = Analysis & { revision: number; entries: string[]; texts: Map<string, TextDocument>; stamps: Map<string, string> };
const ignored = new Set(['.git', '.delta', 'node_modules', '.build', 'target', 'grammars']);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 1000;
const kinds: Record<SemanticSymbol['kind'], SymbolKind> = {
  function: SymbolKind.Function, law: SymbolKind.Function, type: SymbolKind.Struct,
  constructor: SymbolKind.Constructor, parameter: SymbolKind.Variable, variable: SymbolKind.Variable,
  field: SymbolKind.Field, module: SymbolKind.Module,
};
const uriPath = (uri: string) => { try { return fileURLToPath(uri); } catch { return undefined; } };
const stamp = async (file: string) => { const s = await stat(file); return `${s.mtimeMs}:${s.size}:${s.ctimeMs}`; };
function warn(message: string) {
  if (message !== lastWarning) connection.window.showWarningMessage(message);
  lastWarning = message;
}
function invalidate() {
  epoch++;
  cached = undefined;
  pending = undefined;
  worker.stop();
  clearTimeout(timer);
  if (!stopped) timer = setTimeout(() => { void getIndex().catch(() => {}); }, 180);
}
function range(index: Index, span: Span) {
  const doc = index.texts.get(span.uri);
  return doc ? { start: doc.positionAt(span.start), end: doc.positionAt(span.end) } : undefined;
}
function location(index: Index, span: Span) {
  const r = range(index, span);
  return r ? { uri: span.uri, range: r } : undefined;
}
async function current(index: Index, revision: number) {
  if (revision !== epoch || stopped) return false;
  for (const [uri, expected] of index.stamps) {
    if (documents.get(uri)) continue;
    try { if (await stamp(uriPath(uri)!) !== expected) return false; }
    catch { return false; }
  }
  return revision === epoch && !stopped;
}
async function buildIndex(revision: number): Promise<Index> {
  const sources = new Map<string, Source>();
  const stamps = new Map<string, string>();
  let complete = true;
  let entries = 0;
  let bytes = 0;
  const started = Date.now();
  let exhausted = false;
  const limit = () => {
    if (exhausted || entries > 10_000 || sources.size >= MAX_FILES ||
      Date.now() - started > 5000 || bytes >= MAX_BYTES) {
      complete = false;
      exhausted = true;
      return true;
    }
    return false;
  };
  // Reserve budget for unsaved buffers before scanning their disk counterparts.
  for (const doc of documents.all()) {
    const file = uriPath(doc.uri);
    if (!file) continue;
    const text = doc.getText();
    const size = Buffer.byteLength(text);
    if (limit() || size > MAX_BYTES - bytes) { complete = false; exhausted = true; break; }
    bytes += size;
    sources.set(doc.uri, { uri: doc.uri, path: file, text, version: doc.version });
  }
  async function load(file: string) {
    const uri = pathToFileURL(file).href;
    if (sources.has(uri) || documents.get(uri)) return;
    if (limit()) return;
    try {
      const before = await stamp(file);
      const handle = await open(file, 'r');
      let text: string;
      try {
        const size = (await handle.stat()).size;
        if (size > MAX_BYTES - bytes) { complete = false; exhausted = true; return; }
        // The extra byte detects growth without ever reading an unbounded file.
        const buffer = Buffer.alloc(size + 1);
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (count !== size) { complete = false; return; }
        text = buffer.subarray(0, count).toString('utf8');
        bytes += count;
      } finally { await handle.close(); }
      if (before !== await stamp(file)) { complete = false; return; }
      sources.set(uri, { uri, path: file, text });
      stamps.set(uri, before);
    } catch { complete = false; }
  }
  async function scan(directory: string) {
    entries++;
    if (limit()) return;
    try {
      stamps.set(pathToFileURL(directory).href, await stamp(directory));
      for await (const entry of await opendir(directory)) {
        if (revision !== epoch) throw new Error('Analysis superseded');
        entries++;
        if (limit()) break;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !ignored.has(entry.name)) await scan(file);
        else if (entry.isFile() && entry.name.endsWith('.bend')) await load(file);
      }
    } catch { complete = false; }
  }
  for (const root of roots) await scan(root);
  const result: Index = { sources: [], symbols: [], occurrences: [], diagnostics: [],
    complete, revision, entries: [...sources.keys()], texts: new Map(), stamps };
  const symbols = new Map<string, SemanticSymbol>();
  const occurrences = new Map<string, Analysis['occurrences'][number]>();
  const diagnostics = new Map<string, Analysis['diagnostics'][number]>();
  const bindings = new Map<string, NonNullable<Analysis['bindings']>[number]>();
  const allSources = new Map(sources);
  for (const source of sources.values()) {
    if (revision !== epoch) throw new Error('Analysis superseded');
    if (Date.now() - started > 30_000) { result.complete = false; complete = false; break; }
    const analysis = await worker.analyze({
      uri: source.uri, documents: [...sources.values()], rootPaths: roots, allowPackageDownloads: false,
    });
    result.complete &&= analysis.complete;
    for (const s of analysis.sources) {
      // An open document is authoritative even if imported by another compilation.
      if (allSources.has(s.uri) && allSources.get(s.uri)!.text !== s.text)
        throw new Error('Compiler returned an obsolete source snapshot');
      if (!sources.has(s.uri)) allSources.set(s.uri, s);
    }
    for (const symbol of analysis.symbols) symbols.set(symbol.id, symbol);
    for (const occurrence of analysis.occurrences)
      occurrences.set(JSON.stringify(occurrence), occurrence);
    for (const diagnostic of analysis.diagnostics)
      diagnostics.set(JSON.stringify(diagnostic), diagnostic);
    for (const binding of analysis.bindings ?? [])
      bindings.set(JSON.stringify(binding), binding);
  }
  result.sources = [...allSources.values()];
  result.symbols = [...symbols.values()];
  result.occurrences = [...occurrences.values()];
  result.diagnostics = [...diagnostics.values()];
  result.bindings = [...bindings.values()];
  for (const source of result.sources) {
    result.texts.set(source.uri, TextDocument.create(source.uri, 'bend', source.version ?? 0, source.text));
    if (!documents.get(source.uri) && !stamps.has(source.uri) && uriPath(source.uri)) {
      try {
        const file = uriPath(source.uri)!;
        const before = await stamp(file);
        if (await readFile(file, 'utf8') !== source.text) throw new Error('Dependency changed');
        if (await stamp(file) !== before) throw new Error('Dependency changed');
        stamps.set(source.uri, before);
      } catch { throw new Error('Dependency changed during analysis'); }
    }
  }
  if (!await current(result, revision)) throw new Error('Analysis superseded');
  if (!complete) warn('Bend workspace scan is incomplete (file, size, time limit or unreadable directory). Rename is disabled.');
  cached = { epoch: revision, value: result };
  const next = new Set(result.diagnostics.map(d => d.range.uri));
  for (const uri of new Set([...published, ...next, ...documents.all().map(d => d.uri)])) {
    connection.sendDiagnostics({ uri, version: documents.get(uri)?.version, diagnostics:
      result.diagnostics.filter(d => d.range.uri === uri).flatMap(d => {
        const r = range(result, d.range);
        return r ? [{ range: r, message: d.message, code: d.code, source: 'bend', severity: 1 }] : [];
      }),
    });
  }
  published = next;
  return result;
}
async function getIndex(): Promise<Index> {
  const previous = cached;
  if (previous?.epoch === epoch) {
    if (await current(previous.value, previous.epoch)) return previous.value;
    invalidate();
  }
  if (pending?.epoch === epoch) return pending.promise;
  const revision = epoch;
  const promise = buildIndex(revision);
  pending = { epoch: revision, promise };
  try { return await promise; }
  catch (error) {
    if (revision === epoch && !stopped) {
      warn(`Bend analysis unavailable: ${String(error)}`);
      for (const uri of published) connection.sendDiagnostics({ uri, diagnostics: [] });
      published.clear();
    }
    throw error;
  }
  finally { if (pending?.promise === promise) pending = undefined; }
}
async function query<T>(fallback: T, action: (index: Index) => T | Promise<T>): Promise<T> {
  try {
    const index = await getIndex();
    const result = await action(index);
    return await current(index, index.revision) ? result : fallback;
  } catch (error) {
    if (error instanceof ResponseError) throw error;
    return fallback;
  }
}
function selected(index: Index, uri: string, position: { line: number; character: number }) {
  const offset = index.texts.get(uri)?.offsetAt(position);
  if (offset === undefined) return;
  const occurrence = index.occurrences.find(o => o.range.uri === uri && o.range.start <= offset && offset < o.range.end);
  const symbol = index.symbols.find(s => s.id === occurrence?.target);
  return symbol && occurrence ? { symbol, occurrence } : undefined;
}
function visible(s: SemanticSymbol, uri: string, offset: number) {
  if (s.scope) return s.scope.uri === uri && s.scope.start <= offset && offset <= s.scope.end;
  return s.selection.uri === uri;
}
async function safeRename(index: Index, symbol: SemanticSymbol, name?: string) {
  const fail = (message: string): never => { throw new ResponseError(ErrorCodes.InvalidRequest, message); };
  if (!index.complete) fail('Rename requires a complete workspace index. Fix parse/import errors and scan limits first.');
  if (!roots.length) fail('Rename requires an opened workspace folder.');
  const canonicalRoots = await Promise.all(roots.map(root => realpath(root).catch(() => undefined)));
  const writable = async (uri: string) => {
    const file = uriPath(uri);
    const canonical = file && await realpath(file).catch(() => undefined);
    return canonical && canonicalRoots.some(root => {
      if (!root) return false;
      const relative = path.relative(root, canonical);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  };
  if (!await writable(symbol.selection.uri)) fail('Cannot rename unsaved or external declarations.');
  const uses = index.occurrences.filter(o => o.target === symbol.id);
  const writableUses = await Promise.all([...new Set(uses.map(o => o.range.uri))].map(writable));
  if (!uses.length || writableUses.some(result => !result)) fail('Cannot safely edit all occurrences.');
  if (name !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || KEYWORDS.has(name))
      fail('The new name must be a non-keyword Bend identifier.');
    // Conservative: reject both declaration collisions and capture at every use.
    if (index.symbols.some(s => s.id !== symbol.id && s.name === name &&
      (s.selection.uri === symbol.selection.uri || uses.some(o =>
        s.selection.uri === o.range.uri || visible(s, o.range.uri, o.range.start)))))
      fail('Rename could collide with or be shadowed by an existing declaration.');
    if (index.bindings?.some(binding => binding.target !== symbol.id && binding.name === name &&
      uses.some(o => o.range.uri === binding.uri &&
        (!binding.scope || (binding.scope.start <= o.range.start && o.range.start <= binding.scope.end)))))
      fail('Rename could capture an imported or local binding.');
  }
  return uses;
}
async function validateRename(index: Index, uses: Analysis['occurrences'], newName: string) {
  // Recheck the proposed edit without writing it. Source sugar can invoke names
  // implicitly (e.g. M.pure in a do block); those have no text span to rename.
  // Never return edits that break such compiler-resolved dependencies.
  const documents = index.sources.map(source => {
    const ranges = new Map(uses.filter(use => use.range.uri === source.uri)
      .map(use => [`${use.range.start}:${use.range.end}`, use.range]));
    let text = source.text;
    for (const range of [...ranges.values()].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, range.start) + newName + text.slice(range.end);
    }
    return { ...source, text };
  });
  const validation = new AnalyzerWorker();
  const began = Date.now();
  try {
    for (const uri of index.entries) {
      if (index.revision !== epoch || Date.now() - began > 30_000)
        throw new ResponseError(ErrorCodes.InvalidRequest, 'Rename validation was superseded or exceeded its time limit.');
      const result = await validation.analyze({ uri, documents, rootPaths: roots });
      if (!result.complete || result.diagnostics.length) {
        throw new ResponseError(ErrorCodes.InvalidRequest,
          `Rename would break compiler-resolved references: ${result.diagnostics[0]?.message ?? 'incomplete semantic index'}`);
      }
    }
  } finally { validation.stop(); }
}
connection.onInitialize(params => {
  canWatch = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
  canChangeFolders = params.capabilities.workspace?.workspaceFolders === true;
  roots = (params.workspaceFolders?.map(f => uriPath(f.uri)) ??
    [params.rootUri ? uriPath(params.rootUri) : params.rootPath ?? undefined]).filter((p): p is string => !!p);
  return { capabilities: {
    textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full, save: { includeText: false } },
    definitionProvider: true, hoverProvider: true, completionProvider: { triggerCharacters: ['.'] },
    documentSymbolProvider: true, workspaceSymbolProvider: true, referencesProvider: true,
    renameProvider: { prepareProvider: true }, documentHighlightProvider: true, documentFormattingProvider: true,
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
  }, serverInfo: { name: 'Bend2', version: '0.2.1' } };
});
connection.onInitialized(() => {
  if (canWatch) void connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [{ globPattern: '**/*.bend' }],
  }).catch(error => connection.console.warn(`Could not register file watching: ${String(error)}`));
  if (canChangeFolders) connection.workspace.onDidChangeWorkspaceFolders(event => {
    const removed = new Set(event.removed.map(f => uriPath(f.uri)));
    roots = [...new Set([...roots.filter(r => !removed.has(r)), ...event.added.flatMap(f => {
      const p = uriPath(f.uri); return p ? [p] : [];
    })])];
    invalidate();
  });
  invalidate();
});
connection.onDidChangeWatchedFiles(invalidate);
documents.onDidOpen(invalidate);
documents.onDidChangeContent(invalidate);
documents.onDidSave(invalidate);
documents.onDidClose(({ document }) => {
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  published.delete(document.uri);
  invalidate();
});
connection.onDefinition(p => query(null, index => {
  const target = selected(index, p.textDocument.uri, p.position);
  return target ? location(index, target.symbol.selection) ?? null : null;
}));
connection.onHover(p => query(null, index => {
  const target = selected(index, p.textDocument.uri, p.position);
  return target ? { contents: { kind: 'plaintext' as const, value: target.symbol.detail ?? `${target.symbol.kind} ${target.symbol.name}` },
    range: range(index, target.occurrence.range) } : null;
}));
connection.onCompletion(p => query([], index => {
  const doc = index.texts.get(p.textDocument.uri);
  if (!doc) return [];
  const offset = doc.offsetAt(p.position);
  const prefix = doc.getText().slice(0, offset).match(/[A-Za-z0-9_.]*$/)?.[0] ?? '';
  const candidates = index.bindings ? index.bindings.flatMap(binding => {
    if (binding.uri !== doc.uri || !binding.name.startsWith(prefix) ||
      (binding.scope && !(binding.scope.start <= offset && offset <= binding.scope.end))) return [];
    const symbol = index.symbols.find(s => s.id === binding.target);
    return symbol ? [{ ...symbol, name: binding.name, scope: binding.scope }] : [];
  }) : index.symbols.filter(s => visible(s, doc.uri, offset) && s.name.startsWith(prefix));
  const byName = new Map<string, SemanticSymbol>();
  for (const s of candidates.sort((a, b) => (b.scope ? b.scope.end - b.scope.start : Infinity) -
    (a.scope ? a.scope.end - a.scope.start : Infinity))) byName.set(s.name, s);
  // Replace the qualified token explicitly; a client's default word range may
  // exclude '.', turning completion of "Dep.i" into "Dep.Dep.inc".
  const suffix = doc.getText().slice(offset).match(/^[A-Za-z0-9_.]*/)?.[0] ?? '';
  const replacement = { start: doc.positionAt(offset - prefix.length), end: doc.positionAt(offset + suffix.length) };
  return [...byName.values()].map(s => ({ label: s.name, detail: s.detail,
    textEdit: { range: replacement, newText: s.name },
    kind: s.kind === 'function' || s.kind === 'law' ? CompletionItemKind.Function :
      s.kind === 'type' ? CompletionItemKind.Struct : CompletionItemKind.Variable }));
}));
const symbolInfo = (index: Index, s: SemanticSymbol) => {
  const loc = location(index, s.selection);
  return loc ? [{ name: s.name, kind: kinds[s.kind], location: loc, containerName: s.container }] : [];
};
connection.onDocumentSymbol(p => query([], index => index.symbols
  .filter(s => s.selection.uri === p.textDocument.uri && !['variable', 'parameter'].includes(s.kind))
  .flatMap(s => symbolInfo(index, s))));
connection.onWorkspaceSymbol(p => query([], index => index.symbols
  .filter(s => !['variable', 'parameter', 'field'].includes(s.kind) && s.name.toLowerCase().includes(p.query.toLowerCase()))
  .flatMap(s => symbolInfo(index, s)).slice(0, 1000)));
connection.onReferences(p => query([], index => {
  const target = selected(index, p.textDocument.uri, p.position);
  return target ? index.occurrences.filter(o => o.target === target.symbol.id && (p.context.includeDeclaration || !o.declaration))
    .flatMap(o => { const loc = location(index, o.range); return loc ? [loc] : []; }) : [];
}));
connection.onDocumentHighlight(p => query([], index => {
  const target = selected(index, p.textDocument.uri, p.position);
  return target ? index.occurrences.filter(o => o.target === target.symbol.id && o.range.uri === p.textDocument.uri)
    .flatMap(o => { const r = range(index, o.range); return r ? [{ range: r, kind: 1 }] : []; }) : [];
}));
connection.onPrepareRename(p => query(null, async index => {
  const target = selected(index, p.textDocument.uri, p.position);
  if (!target) return null;
  await safeRename(index, target.symbol);
  return { range: range(index, target.occurrence.range)!, placeholder: target.symbol.name };
}));
connection.onRenameRequest(p => query(null, async index => {
  const target = selected(index, p.textDocument.uri, p.position);
  if (!target) return null;
  const uses = await safeRename(index, target.symbol, p.newName);
  await validateRename(index, uses, p.newName);
  const edits = new Map<string, { range: NonNullable<ReturnType<typeof range>>; newText: string }[]>();
  for (const use of uses) {
    const r = range(index, use.range);
    if (!r) throw new ResponseError(ErrorCodes.InvalidRequest, 'Missing source for rename');
    const list = edits.get(use.range.uri) ?? [];
    if (!list.some(e => JSON.stringify(e.range) === JSON.stringify(r))) list.push({ range: r, newText: p.newName });
    edits.set(use.range.uri, list);
  }
  return { documentChanges: [...edits].map(([uri, edits]) => ({
    textDocument: { uri, version: documents.get(uri)?.version ?? null }, edits,
  })) };
}));
connection.onDocumentFormatting(p => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const formatted = formatBend(text, p.options);
  return text === formatted ? [] : [{ range: { start: doc.positionAt(0), end: doc.positionAt(text.length) }, newText: formatted }];
});
function stop() { stopped = true; clearTimeout(timer); worker.stop(); }
connection.onShutdown(stop);
connection.onExit(() => { stop(); process.exit(0); });
process.once('SIGTERM', () => { stop(); process.exit(0); });
process.once('SIGINT', () => { stop(); process.exit(0); });
documents.listen(connection);
connection.listen();
