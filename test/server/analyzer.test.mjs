import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { analyze } from '../../.build/lsp/analyzer.mjs';

const root = path.resolve('.build/analyzer-tests');
await fs.mkdir(root, { recursive: true });
let serial = 0;
async function fixture(files, entry = 'main.bend') {
  const dir = path.join(root, String(++serial));
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  const document = (name, text) => ({ path: path.join(dir, name), uri: pathToFileURL(path.join(dir, name)).href, text });
  const request = { uri: document(entry, '').uri, rootPaths: [dir], documents: [] };
  return { dir, request, document, run: documents => analyze({ ...request, documents: documents ?? [] }) };
}
const prelude = 'type U is Data:\n  Unit{}\n';
const local = (analysis, uri) => analysis.symbols.filter(s => s.selection.uri === uri);
const refs = (analysis, symbol) => analysis.occurrences.filter(o => o.target === symbol.id && !o.declaration);
function at(analysis, uri, start) {
  return analysis.occurrences.find(o => o.range.uri === uri && o.range.start === start);
}
function valid(analysis) { assert.deepEqual(analysis.diagnostics, []); assert.equal(analysis.complete, true); }

function renamed(analysis, symbol, text, name) {
  const ranges = analysis.occurrences.filter(o => o.target === symbol.id && o.range.uri === symbol.selection.uri)
    .map(o => o.range).sort((a, b) => b.start - a.start);
  for (const span of ranges) text = text.slice(0, span.start) + name + text.slice(span.end);
  return text;
}

test('quantity whitespace and dotted locals preserve compiler spellings and references', async () => {
  for (const [declaration, name] of [['+  x', 'x'], ['x.y', 'x.y']]) {
    const text = prelude + `def id(${declaration}: U) -> U:\n  ${name}\n`;
    const f = await fixture({ 'main.bend': text });
    const a = await f.run();
    valid(a);
    const binding = a.bindings.find(b => b.name === name && b.scope);
    assert.ok(binding, name);
    const symbol = a.symbols.find(s => s.id === binding.target);
    assert.equal(refs(a, symbol).length, 1);
    if (name.includes('.')) assert.ok(!a.bindings.some(b => b.name === 'y'));
  }
});

test('failed law implementation restores the accepted law lookup', async () => {
  const text = prelude + 'law id: for x: U U\ndef call(x: U) -> U:\n  id(x)\ndef id(x):\n  x =\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  assert.equal(a.complete, false);
  const law = a.symbols.find(s => s.kind === 'law' && s.name === 'id');
  assert.ok(law);
  assert.equal(at(a, f.request.uri, text.indexOf('id(x)\n')).target, law.id);
  assert.ok(a.bindings.some(b => b.name === 'id' && b.target === law.id));
});

test('array writes retain a single source identity and remain valid after rename', async () => {
  const text = 'import Base\ndef f(a: Array<U32>) -> Array<U32>:\n  a[0] <- 1\n  a\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  valid(a);
  const variables = local(a, f.request.uri).filter(s => s.name === 'a');
  assert.equal(variables.length, 1);
  assert.equal(refs(a, variables[0]).length, 2);
  const updated = renamed(a, variables[0], text, 'values');
  valid(await f.run([f.document('main.bend', updated)]));
});

test('explicit do heads participate in alias references and safe alias rename', async () => {
  const dep = prelude + 'type M<-T: Type> is Type:\n  Wrap{value: T}\ndef M.pure(-T: Type, x: T) -> M<T>:\n  Wrap{x}\n';
  const main = 'import ./dep.bend as D\ndef f(x: D.U) -> D.M<D.U>:\n  do D.M<D.U>:\n    return x\n';
  const f = await fixture({ 'main.bend': main, 'dep.bend': dep });
  const a = await f.run();
  valid(a);
  const alias = local(a, f.request.uri).find(s => s.kind === 'module');
  assert.equal(at(a, f.request.uri, main.indexOf('do D.M') + 3).target, alias.id);
  const updated = renamed(a, alias, main, 'E');
  assert.ok(updated.includes('do E.M<E.U>'));
  valid(await f.run([f.document('main.bend', updated)]));
});

test('official parser binder identities distinguish parameter, let and lambda shadowing', async () => {
  const text = prelude + 'def id(x: U) -> U:\n  x = x\n  (x => x)(x)\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  valid(a);
  const xs = local(a, f.request.uri).filter(s => s.name === 'x');
  assert.equal(xs.length, 3);
  assert.equal(new Set(xs.map(s => s.id)).size, 3);
  for (const x of xs) assert.equal(refs(a, x).length, 1);
  assert.equal(at(a, f.request.uri, text.indexOf('= x') + 2).target, xs[0].id);
  assert.equal(at(a, f.request.uri, text.lastIndexOf('(x)') + 1).target, xs[1].id);
  assert.equal(at(a, f.request.uri, text.indexOf('=> x') + 3).target, xs[2].id);
  assert.ok(xs[2].scope.end < text.lastIndexOf('(x)') + 1);
  assert.equal(xs[0].detail, 'x: U');
});

test('import aliases resolve one physical declaration with namespace-independent IDs and suffix-only spans', async () => {
  const dep = prelude + 'def id(x: U) -> U:\n  x\n';
  const main = 'import ./dep.bend as A\nimport ./dep.bend as B\ndef call(x: A.U) -> B.U:\n  A.id(x)\n';
  const f = await fixture({ 'main.bend': main, 'dep.bend': dep });
  const a = await f.run();
  valid(a);
  const id = a.symbols.find(s => s.name === 'id');
  const own = await analyze({ ...f.request, uri: f.document('dep.bend', dep).uri });
  valid(own);
  assert.equal(id.id, own.symbols.find(s => s.name === 'id').id);
  const use = refs(a, id)[0];
  assert.equal(main.slice(use.range.start, use.range.end), 'id');
  assert.equal(use.range.start, main.indexOf('A.id') + 2);
  assert.ok(a.bindings.some(b => b.uri === f.request.uri && b.name === 'A.id' && b.target === id.id));
  assert.ok(a.bindings.some(b => b.uri === f.request.uri && b.name === 'B.id' && b.target === id.id));
  assert.equal(a.sources.find(s => s.uri === f.request.uri).text, main);
});

test('constructors, pattern binders and match arm scopes come from compiler patterns', async () => {
  const text = 'type N is Data:\n  Z{}\n  S{pred: N}\ndef pred(n: N) -> N:\n  match n:\n    case Z{}:\n      Z{}\n    case S{x}:\n      x\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  valid(a);
  const z = a.symbols.find(s => s.name === 'Z');
  const s = a.symbols.find(s => s.name === 'S');
  const x = a.symbols.find(s => s.name === 'x');
  assert.equal(z.kind, 'constructor');
  assert.equal(refs(a, z).length, 2);
  assert.equal(refs(a, s).length, 1);
  assert.equal(refs(a, x).length, 1);
  assert.equal(at(a, f.request.uri, text.lastIndexOf('x')).target, x.id);
  assert.ok(x.scope.start > text.indexOf('case S{x}'));
});

test('Base navigation, declared hover and actual compiler type errors', async () => {
  const text = 'import Base\ndef id(x: U32) -> U32:\n  x\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  valid(a);
  const u32 = a.symbols.find(s => s.name === 'U32' && s.kind === 'type');
  assert.ok(u32.selection.uri.endsWith('/base.bend'));
  assert.equal(refs(a, u32).filter(o => o.range.uri === f.request.uri).length, 2);
  assert.match(local(a, f.request.uri).find(s => s.name === 'id').detail, /U32/);
  const bad = await f.run([f.document('main.bend', 'import Base\ndef bad() -> U32:\n  Type\n')]);
  assert.equal(bad.complete, false);
  assert.ok(bad.diagnostics.length);
  assert.equal(bad.diagnostics[0].range.uri, f.request.uri);
  assert.ok(bad.diagnostics[0].range.start > 12);
});

test('unsaved transitive imports, nonexistent overlays, and close/reopen disk restoration', async () => {
  const dep = prelude + 'def id(x: U) -> U:\n  x\n';
  const main = 'import ./dep.bend as D\ndef f(x: D.U) -> D.U:\n  D.id(x)\n';
  const f = await fixture({ 'main.bend': main, 'dep.bend': dep });
  const modified = dep.replaceAll('id', 'renamed');
  const editedMain = main.replace('D.id', 'D.renamed');
  const a = await f.run([f.document('main.bend', editedMain), f.document('dep.bend', modified)]);
  valid(a);
  assert.ok(a.symbols.some(s => s.name === 'renamed'));
  const disk = await f.run();
  valid(disk);
  assert.ok(disk.symbols.some(s => s.name === 'id'));
  assert.ok(!disk.symbols.some(s => s.name === 'renamed'));
  const absent = await f.run([
    f.document('main.bend', main.replace('dep.bend', 'new.bend')),
    f.document('new.bend', dep),
  ]);
  valid(absent);
  assert.ok(absent.sources.some(s => s.path.endsWith('/new.bend')));
});

test('incomplete edits keep only accepted declaration prefixes and no guessed references', async () => {
  const text = prelude + 'def good(x: U) -> U:\n  x\ndef broken(x: U) -> U:\n  x =\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  assert.equal(a.complete, false);
  assert.ok(a.diagnostics.length);
  assert.ok(a.symbols.some(s => s.name === 'good'));
  assert.ok(!a.symbols.some(s => s.name === 'broken'));
  assert.ok(a.occurrences.every(o => o.range.start < text.indexOf('def broken')));
  const unresolved = await f.run([f.document('main.bend', prelude + 'def bad() -> U:\n  missing\n')]);
  assert.ok(unresolved.diagnostics.length);
  assert.ok(!unresolved.occurrences.some(o => o.range.start === (prelude + 'def bad() -> U:\n  ').length));
});

test('UTF-16 offsets preserve CRLF, astral comments, imports and qualified declaration suffixes', async () => {
  const text = '# 🦋 UTF-16\r\nimport Base\r\ndef Num.id(x: U32) -> U32:\r\n  x\r\ndef use(x: U32) -> U32:\r\n  Num.id(x)\r\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  valid(a);
  const id = local(a, f.request.uri).find(s => s.name === 'id');
  assert.equal(id.selection.start, text.indexOf('Num.id') + 4);
  assert.equal(text.slice(id.selection.start, id.selection.end), 'id');
  assert.equal(refs(a, id)[0].range.start, text.lastIndexOf('Num.id') + 4);
  assert.equal(a.sources.find(s => s.uri === f.request.uri).text, text);
});

test('cycles and missing local/package imports are diagnostics, never downloads', async () => {
  const f = await fixture({
    'main.bend': 'import ./dep.bend as D\n',
    'dep.bend': 'import ./main.bend as M\n',
  });
  const cycle = await f.run();
  assert.match(cycle.diagnostics[0].message, /cycle/);
  const missing = await f.run([f.document('main.bend', 'import ./absent.bend as A\n')]);
  assert.match(missing.diagnostics[0].message, /no such file/);
  const cached = await f.run([f.document('main.bend', 'import absent-package@999.999.999.999/main.bend as A\n')]);
  assert.match(cached.diagnostics[0].message, /cached package/);
  const requested = await analyze({ ...f.request, allowPackageDownloads: true });
  assert.ok(requested.diagnostics.some(d => d.code === 'bend-offline'));
});

test('foreign imports are parsed and checked, never evaluated', async () => {
  const f = await fixture({
    'main.bend': 'import Base\ndef foreign() -> IO(U32):\n  import "./never-execute.js"\n',
    'never-execute.js': 'throw new Error("THIS MUST NEVER EXECUTE")',
  });
  const a = await f.run();
  assert.ok(!a.diagnostics.some(d => d.message.includes('THIS MUST NEVER EXECUTE')));
  assert.ok(a.symbols.some(s => s.name === 'foreign'));
  assert.ok(a.sources.every(s => s.path.endsWith('.bend')));
});

test('identical source contents keep distinct identities and precise diagnostic file origins', async () => {
  const identical = prelude + 'def bad(x: U) -> U:\n  Type\n';
  const f = await fixture({
    'main.bend': 'import ./one.bend as One\nimport ./two.bend as Two\n',
    'one.bend': identical,
    'two.bend': identical,
  });
  const a = await f.run();
  const one = f.document('one.bend', identical).uri;
  const two = f.document('two.bend', identical).uri;
  assert.notEqual(a.symbols.find(s => s.name === 'bad' && s.selection.uri === one).id,
    a.symbols.find(s => s.name === 'bad' && s.selection.uri === two).id);
  assert.equal(a.diagnostics[0].range.uri, one);
  assert.equal(a.diagnostics[0].range.start, identical.indexOf('Type'));
});

test('type and identically named constructor have separate compiler identities', async () => {
  const text = 'type Box is Data:\n  Box{}\ndef box() -> Box:\n  Box{}\n';
  const f = await fixture({ 'main.bend': text });
  const a = await f.run();
  valid(a);
  const type = a.symbols.find(s => s.kind === 'type' && s.name === 'Box');
  const constructor = a.symbols.find(s => s.kind === 'constructor' && s.name === 'Box');
  assert.equal(refs(a, type).length, 1);
  assert.equal(refs(a, constructor).length, 1);
  assert.equal(refs(a, type)[0].range.start, text.indexOf('-> Box') + 3);
  assert.equal(refs(a, constructor)[0].range.start, text.lastIndexOf('Box{}'));
});

test('alias declarations and qualifier references are independent from imported suffix references', async () => {
  const text = 'import ./dep.bend as as\ndef use(x: as.U) -> as.U:\n  as.id(x)\n';
  const f = await fixture({ 'main.bend': text, 'dep.bend': prelude + 'def id(x: U) -> U:\n  x\n' });
  const a = await f.run();
  valid(a);
  const alias = a.symbols.find(s => s.kind === 'module' && s.name === 'as');
  assert.equal(alias.selection.start, text.indexOf('as as') + 3);
  assert.equal(refs(a, alias).length, 3);
  for (const occurrence of refs(a, alias)) assert.equal(text.slice(occurrence.range.start, occurrence.range.end), 'as');
  const id = a.symbols.find(s => s.kind === 'function' && s.name === 'id');
  assert.equal(text.slice(refs(a, id)[0].range.start, refs(a, id)[0].range.end), 'id');
});

test('transitive nonexistent overlays load through the official loader and typed lets retain written types', async () => {
  const f = await fixture({ 'main.bend': 'import ./middle.bend as M\ndef f(x: M.U) -> M.U:\n  M.id(x)\n' });
  const middle = 'import ./leaf.bend as L\ntype U is Data:\n  Unit{}\ndef id(x: U) -> U:\n  y: U = x\n  y\n';
  const a = await f.run([f.document('middle.bend', middle), f.document('leaf.bend', prelude)]);
  valid(a);
  assert.equal(a.sources.length, 3);
  const y = a.symbols.find(s => s.name === 'y');
  assert.equal(y.kind, 'variable');
  assert.equal(y.detail, 'y: U');
});

test('ambiguous imported names produce official diagnostics and no speculative suffix references', async () => {
  const dep = 'import Base\ndef add(x: U32, y: U32) -> U32:\n  (x + y : U32)\n';
  const main = 'import Base\nimport ./dep.bend as U32\ndef bad(x: U32, y: U32) -> U32:\n  U32.add(x, y)\n';
  const f = await fixture({ 'main.bend': main, 'dep.bend': dep });
  const a = await f.run();
  assert.equal(a.complete, false);
  assert.match(a.diagnostics[0].message, /unambiguous/);
  assert.equal(at(a, f.request.uri, main.indexOf('U32.add') + 4), undefined);
});

test('source limits apply before loading disk or overlay dependencies outside workspace roots', async () => {
  const large = '#' + 'x'.repeat(2 * 1024 * 1024);
  const f = await fixture({ 'main.bend': 'import ./large.bend as Large\n', 'large.bend': large });
  for (const documents of [[], [f.document('large.bend', large)]]) {
    const a = await analyze({ ...f.request, rootPaths: [], documents });
    assert.equal(a.complete, false);
    assert.match(a.diagnostics[0].message, /source limits/);
    assert.equal(a.diagnostics[0].range.uri, f.request.uri);
    assert.equal(a.sources.length, 1);
  }
});
