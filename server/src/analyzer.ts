import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Bend from '../vendor/bend.js';
import type { Analysis, AnalyzeRequest, Diagnostic, Occurrence, Source, Span, Symbol } from './model.js';

// The compiler is the only parser and resolver. These observations are collected
// before its desugaring erases source binders. Nothing here executes foreign code,
// fetches packages, writes caches, or substitutes an editor-specific type checker.
type Pending = { range: Span; canonical?: string; target?: string };
type State = {
  source: Source;
  tokens: Map<number, { name: string; span: Bend.Span }>;
  last?: { name: string; span: Bend.Span };
  locals: Map<number, Symbol>;
  top: number;
  container?: Symbol;
  owner?: Symbol;
};

// These limits also apply to dependencies outside the workspace scanner. The
// supervising LSP worker supplies the CPU deadline and heap isolation.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SOURCES = 256;

export async function analyze(request: AnalyzeRequest): Promise<Analysis> {
  const book = Bend.book_nil();
  const sources = new Map<string, Source>();
  const sourceTexts = new Map<string, Source[]>();
  const symbols = new Map<string, Symbol>();
  const localNames = new Map<string, string>();
  const canonical = new Map<string, string>();
  const declarationNames = new Map<string, string>();
  const aliases = new Map<string, Map<string, Symbol>>();
  const pending = new Map<string, Pending>();
  const diagnostics: Diagnostic[] = [];
  const states = new Map<Bend.Parse, State>();
  const overlays = new Map<string, Source>();
  const lib = path.resolve(process.env.BEND_LIB ?? path.join(os.homedir(), '.bend', 'lib'));
  const normalize = (file: string): string => {
    const absolute = path.resolve(file);
    try { return fs.realpathSync(absolute); } catch { return absolute; }
  };
  for (const document of request.documents) overlays.set(normalize(document.path), document);
  const entry = normalize(fileURLToPath(request.uri));
  let current: Source | undefined;
  let complete = true;
  let totalBytes = 0;
  const key = (span: Span) => `${span.uri}#${span.start}`;
  const rememberText = (text: string, source: Source) => {
    const old = sourceTexts.get(text) ?? [];
    if (!old.some(s => s.uri === source.uri)) old.push(source);
    sourceTexts.set(text, old);
  };
  const read = (file: string, spn?: Bend.Span): string => {
    file = normalize(file);
    if (sources.has(file)) return sources.get(file)!.text;
    if (sources.size >= MAX_SOURCES) {
      throw Bend.Err(book, Bend.ctx_nil(), `at most ${MAX_SOURCES} source files per analysis`, undefined, spn);
    }
    const document = overlays.get(file);
    const stat = document ? undefined : fs.statSync(file);
    if (stat && !stat.isFile()) throw Bend.Err(book, Bend.ctx_nil(), `a regular source file: ${file}`, undefined, spn);
    const bytes = document ? Buffer.byteLength(document.text, 'utf8') : stat!.size;
    if (bytes > MAX_SOURCE_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) {
      throw Bend.Err(book, Bend.ctx_nil(), 'source limits: 2 MiB per file and 16 MiB per analysis', undefined, spn);
    }
    totalBytes += bytes;
    const source: Source = document
      ? { ...document, path: file }
      : { uri: pathToFileURL(file).href, path: file, text: fs.readFileSync(file, 'utf8') };
    sources.set(file, source);
    rememberText(source.text, source);
    return source.text;
  };
  const state = (p: Bend.Parse) => states.get(p)!;
  // Only compiler-lexed name tokens can become identifier occurrences. In
  // particular, desugared sugar/literals never invent rename locations.
  const token = (p: Bend.Parse, span?: Bend.Span) => {
    if (!span) return undefined;
    const st = state(p);
    const exact = st.tokens.get(span.beg);
    if (exact) return exact;
    // Compiler spans may include quantity prefixes and arbitrary trivia. Select
    // the first actual compiler-lexed token inside that span, never guessed text.
    let first: State['last'];
    for (const candidate of st.tokens.values()) {
      if (candidate.span.beg >= span.beg && candidate.span.end <= span.end &&
        (!first || candidate.span.beg < first.span.beg)) first = candidate;
    }
    return first;
  };
  const selection = (p: Bend.Parse, t: { name: string; span: Bend.Span }): Span => ({
    uri: state(p).source.uri,
    start: t.span.beg + t.name.lastIndexOf('.') + 1,
    end: t.span.end,
  });
  const aliasReference = (p: Bend.Parse, t: { name: string; span: Bend.Span }) => {
    if (!t.name.includes('.')) return;
    const name = t.name.slice(0, t.name.indexOf('.'));
    const symbol = aliases.get(state(p).source.uri)?.get(name);
    if (!symbol || !(name in p.al)) return;
    const range = { uri: state(p).source.uri, start: t.span.beg, end: t.span.beg + name.length };
    pending.set(key(range), { range, target: symbol.id });
  };
  const finishTop = (p: Bend.Parse) => {
    const st = state(p);
    for (const symbol of symbols.values()) {
      if (symbol.selection.uri === st.source.uri && symbol.exported && symbol.selection.start >= st.top) {
        symbol.range.end = p.pos;
      }
    }
  };
  const close = (p: Bend.Parse, ids: number[]) => {
    const st = state(p);
    for (const i of ids) {
      const symbol = st.locals.get(i);
      if (symbol?.scope) symbol.scope.end = p.pos;
    }
  };
  const failure = (message: string, spn?: Bend.Span): never => {
    throw Bend.Err(book, Bend.ctx_nil(), message, undefined, spn);
  };
  book.editor = {
    file(file, spn) {
      const real = normalize(file);
      if (overlays.has(real) || fs.existsSync(real)) return real;
      return failure(`no such file: ${file}${file.startsWith(lib + path.sep) ? ' (package downloads are disabled; populate BEND_LIB locally)' : ''}`, spn);
    },
    read,
    name(nv, spn) {
      if (!Bend.NAMED.test(nv)) return failure('a package as <name>@<version>', spn);
      const at = path.join(lib, 'names', nv);
      const stat = fs.existsSync(at) ? fs.statSync(at) : undefined;
      const hash = stat?.isFile() && stat.size <= 128 ? fs.readFileSync(at, 'utf8').trim() : '';
      if (!/^0x[0-9a-f]{32}$/.test(hash)) return failure(`a cached package named ${nv} in BEND_LIB (package downloads are disabled)`, spn);
      return hash;
    },
    source(file, original, parsed) {
      current = sources.get(normalize(file))!;
      rememberText(original, current);
      rememberText(parsed, current);
    },
    importAlias(file, name, namespace, beg) {
      const source = sources.get(normalize(file))!;
      const s = { uri: source.uri, start: beg, end: beg + name.length };
      const symbol: Symbol = {
        id: key(s), name, kind: 'module', selection: s, range: s,
        scope: { uri: source.uri, start: 0, end: source.text.length },
        detail: `import ${namespace} as ${name}`,
      };
      symbols.set(symbol.id, symbol);
      const names = aliases.get(source.uri) ?? new Map();
      names.set(name, symbol);
      aliases.set(source.uri, names);
    },
    begin(p) {
      p.file = current!.path;
      states.set(p, { source: current!, tokens: new Map(), locals: new Map(), top: 0 });
    },
    top(p) {
      finishTop(p);
      const st = state(p);
      st.top = p.pos;
      st.container = undefined;
      st.owner = undefined;
      st.locals.clear();
    },
    end(p, success) {
      close(p, p.stk.map(([, i]) => i));
      finishTop(p);
      if (!success) {
        // A failed declaration may have speculative pattern/let reads. Retain
        // only whole declarations accepted before it, never guessed identities.
        const st = state(p);
        for (const [id, symbol] of symbols) {
          if (symbol.selection.uri === st.source.uri && symbol.selection.start >= st.top) symbols.delete(id);
        }
        for (const [id, occurrence] of pending) {
          if (occurrence.range.uri === st.source.uri && occurrence.range.start >= st.top) pending.delete(id);
        }
        // A failed definition can replace an earlier law. Rebuild from accepted
        // declarations so its prior navigable identity is restored, not deleted.
        canonical.clear();
        for (const [id, name] of declarationNames) {
          if (symbols.has(id)) canonical.set(name, id);
        }
      }
    },
    nameToken(p, name, span) {
      const st = state(p);
      st.last = { name, span };
      st.tokens.set(span.beg, st.last);
    },
    bind(p, name, i, span, T, local) {
      const st = state(p);
      const t = token(p, span);
      if (!t || t.name !== name) return;
      const s = selection(p, t);
      const symbol: Symbol = {
        id: key(s), name: name.split('.').at(-1)!, selection: s, range: s,
        kind: !local && T ? (st.container?.kind === 'constructor' ? 'field' : 'parameter') : 'variable',
        scope: { uri: s.uri, start: p.pos, end: st.source.text.length },
        container: st.container?.id,
        detail: T ? `${name}: ${T.$ === 'Qnt' ? 'Quant' : T.s ? p.str.slice(T.s.beg, T.s.end) : Bend.term_show(T)}` : name,
      };
      st.locals.set(i, symbol);
      localNames.set(symbol.id, name);
      symbols.set(symbol.id, symbol);
      pending.delete(key(s));
    },
    rebind(p, from, to) {
      // Array-write sugar reads the old variable and binds an updated value.
      // There is no written new declaration: both compiler IDs represent the
      // same renameable source variable.
      const st = state(p);
      const original = st.locals.get(from);
      const generated = st.locals.get(to);
      if (generated) {
        symbols.delete(generated.id);
        localNames.delete(generated.id);
      }
      if (original && generated) {
        st.locals.set(to, original);
        pending.set(key(generated.selection), { range: generated.selection, target: original.id });
      } else {
        st.locals.delete(to);
        complete = false;
      }
    },
    close,
    reference(p, name, span, i, constructor) {
      const t = token(p, span);
      if (!t || t.name === '_' || t.name.split('.').at(-1) !== name.split('.').at(-1)) return;
      const range = selection(p, t);
      const local = i === undefined ? undefined : state(p).locals.get(i);
      // A bound compiler identity without a written declaration (generated
      // binders) is not a global reference.
      if (i !== undefined && !local) return;
      if (i === undefined) aliasReference(p, t);
      pending.set(key(range), { range, target: local?.id, canonical: i === undefined ? (constructor ? `ctr:${name}` : name) : undefined });
    },
    declaration(p, _name, resolved, kind) {
      const st = state(p);
      const t = st.last!;
      aliasReference(p, t);
      const s = selection(p, t);
      const symbol: Symbol = {
        id: key(s), name: t.name.split('.').at(-1)!, kind, selection: s,
        range: { uri: s.uri, start: kind === 'constructor' ? t.span.beg : st.top, end: p.pos },
        exported: true,
        container: kind === 'constructor' ? st.owner?.id : undefined,
      };
      symbols.set(symbol.id, symbol);
      // The definition filling a law is the navigable declaration.
      const canonicalName = kind === 'constructor' ? `ctr:${resolved}` : resolved;
      declarationNames.set(symbol.id, canonicalName);
      canonical.set(canonicalName, symbol.id);
      st.container = symbol;
      if (kind !== 'constructor') st.owner = symbol;
    },
  };
  const report = (error: unknown, code: string) => {
    complete = false;
    const err = error as Bend.Err;
    const fallback = err.def ? symbols.get(canonical.get(err.def) ?? '')?.selection : undefined;
    const matches = err.spn ? sourceTexts.get(err.spn.src) : undefined;
    const source = err.spn?.file ? sources.get(normalize(err.spn.file)) : matches?.length === 1 ? matches[0] : undefined;
    const range = source && err.spn
      ? { uri: source.uri, start: Math.min(err.spn.beg, source.text.length), end: Math.min(Math.max(err.spn.end, err.spn.beg + 1), source.text.length) }
      : fallback ?? { uri: request.uri, start: 0, end: 0 };
    const show = (value: Bend.Expr) => typeof value === 'string' ? value : Bend.term_show(Bend.term_lower(value));
    const message = err.$ === 'Err'
      ? `${show(err.exp)}${err.obs === undefined ? '' : `; observed ${show(err.obs)}`}${err.nte ? `\n${err.nte}` : ''}`
      : error instanceof Error ? error.message : String(error);
    diagnostics.push({ range, message, code });
  };
  try {
    // Upstream namespaces are entry-relative. Public IDs deliberately aren't.
    await Bend.book_load(book, entry, path.basename(entry, '.bend'), new Map());
    Bend.book_valid(book);
  } catch (error) {
    report(error, 'bend');
  }
  if (request.allowPackageDownloads) {
    diagnostics.push({ range: { uri: request.uri, start: 0, end: 0 }, code: 'bend-offline',
      message: 'Package downloads are not supported by the language server. Populate BEND_LIB with the official CLI; analysis uses its local cache only.' });
    complete = false;
  }
  // Print declared types without normalization: hover must not execute a reducer
  // or present a guessed/inferred type when checking failed.
  for (const [name, id] of canonical) {
    const symbol = symbols.get(id)!;
    const declaration = name.startsWith('ctr:') ? book.ctrs[name.slice(4)] : book.tlds[name];
    if (declaration) {
      try { symbol.detail = `${symbol.kind} ${symbol.name}: ${Bend.term_show(Bend.term_lower(declaration.T))}`; }
      catch { symbol.detail = `${symbol.kind} ${symbol.name}`; }
    }
  }
  const occurrences: Occurrence[] = [...symbols.values()].map(symbol => ({
    target: canonical.get(declarationNames.get(symbol.id) ?? '') ?? symbol.id,
    range: symbol.selection, declaration: true,
  }));
  for (const occurrence of pending.values()) {
    if (symbols.has(key(occurrence.range))) continue;
    const target = occurrence.target ?? canonical.get(occurrence.canonical!);
    if (target && symbols.has(target)) occurrences.push({ target, range: occurrence.range });
    else complete = false;
  }
  const bindings: { uri: string; name: string; target: string; scope?: Span }[] = [];
  for (const [p, st] of states) {
    for (const [qualified, target] of canonical) {
      const name = qualified.startsWith('ctr:') ? qualified.slice(4) : qualified;
      const candidates = new Set<string>();
      if (p.ns && name.startsWith(p.ns + '.')) candidates.add(name.slice(p.ns.length + 1));
      if (book.tlds[name]?.b || (book.ctrs[name] && !name.includes('/'))) candidates.add(name);
      for (const [alias, ns] of Object.entries(p.al)) {
        if (name.startsWith(ns + '.')) candidates.add(alias + name.slice(ns.length));
      }
      for (const visible of candidates) {
        try {
          if (Bend.parse_reso(p, visible) === name) bindings.push({ uri: st.source.uri, name: visible, target });
        } catch { /* An ambiguous alias is not a completion candidate. */ }
      }
    }
  }
  for (const symbol of symbols.values()) if (!symbol.exported) {
    bindings.push({ uri: symbol.selection.uri, name: localNames.get(symbol.id) ?? symbol.name,
      target: symbol.id, scope: symbol.scope });
  }
  return { sources: [...sources.values()], symbols: [...symbols.values()], occurrences, diagnostics, complete, bindings };
}
