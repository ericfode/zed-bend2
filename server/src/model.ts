// Offsets are JavaScript UTF-16 code units, matching the compiler and LSP.
export type Source = { uri: string; path: string; text: string; version?: number };
export type Span = { uri: string; start: number; end: number };
export type SymbolKind = 'function' | 'law' | 'type' | 'constructor' | 'parameter' | 'variable' | 'field' | 'module';
export type Symbol = {
  id: string;
  name: string;
  kind: SymbolKind;
  selection: Span;
  range: Span;
  scope?: Span;
  detail?: string;
  container?: string;
  exported?: boolean;
};
export type Occurrence = { target: string; range: Span; declaration?: boolean };
export type Diagnostic = { range: Span; message: string; code: string };
export type Analysis = {
  sources: Source[];
  symbols: Symbol[];
  occurrences: Occurrence[];
  diagnostics: Diagnostic[];
  complete: boolean;
  // Compiler-resolved visible spellings, including per-file import aliases.
  bindings?: { uri: string; name: string; target: string; scope?: Span }[];
};
export type AnalyzeRequest = {
  uri: string;
  documents: Source[];
  rootPaths: string[];
  allowPackageDownloads?: boolean;
};
