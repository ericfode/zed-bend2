import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, symlink, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = path.join(project, '.build', 'lsp test fixtures');

// Exercise the deployed stdio transport, not server internals or mock semantics.
async function start(t, files) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'project-'));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  const child = spawn(process.execPath, ['.build/lsp/launcher.mjs', '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let buffer = Buffer.alloc(0);
  let id = 0;
  const requests = new Map();
  const notifications = [];
  const exit = once(child, 'exit');
  void exit.then(([code, signal]) => {
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Server exited (${code ?? signal})\n${stderr}`));
    }
    requests.clear();
  });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const header = buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const length = Number(buffer.subarray(0, header).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
      assert.ok(Number.isFinite(length), 'valid Content-Length framing');
      if (buffer.length < header + 4 + length) return;
      const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
      buffer = buffer.subarray(header + 4 + length);
      if (message.id !== undefined && !message.method) {
        const request = requests.get(message.id);
        if (!request) continue;
        requests.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
        else request.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: null });
      } else notifications.push(message);
    }
  });
  function send(message) {
    const json = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);
    child.stdin.write(json);
  }
  function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        requests.delete(key);
        reject(new Error(`Timed out: ${method}\n${stderr}`));
      }, 40_000);
      requests.set(key, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id: key, method, params });
    });
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Server stopped\n${stderr}`));
    }
    await rm(root, { recursive: true, force: true });
  });
  const uri = name => pathToFileURL(path.join(root, name)).href;
  const initialized = await request('initialize', {
    processId: process.pid,
    capabilities: { workspace: { workspaceFolders: true }, textDocument: {} },
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'fixture' }],
  });
  notify('initialized', {});
  const open = (name, text = files[name], version = 1) =>
    notify('textDocument/didOpen', { textDocument: { uri: uri(name), languageId: 'bend', version, text } });
  const change = (name, text, version) =>
    notify('textDocument/didChange', { textDocument: { uri: uri(name), version }, contentChanges: [{ text }] });
  const at = (name, text, needle, occurrence = 0) => {
    let offset = -1;
    for (let n = 0; n <= occurrence; n++) offset = text.indexOf(needle, offset + 1);
    assert.notEqual(offset, -1, `fixture contains ${needle}`);
    const before = text.slice(0, offset).split('\n');
    return { textDocument: { uri: uri(name) }, position: { line: before.length - 1, character: before.at(-1).length } };
  };
  return { root, child, exit, uri, initialized, request, notify, notifications, open, change, at };
}

const dep = 'import Base\ndef inc(x: U32) -> U32:\n  x\n';
const main = 'import Base\nimport ./dep.bend as Dep\n\ndef first(x: U32) -> U32:\n  Dep.inc(x)\n\ndef second(x: U32) -> U32:\n  x\n';
const closed = 'import Base\nimport ./dep.bend as Dep\n\ndef closed(x: U32) -> U32:\n  Dep.inc(x)\n';

test('stdio semantic features use compiler identities across open and closed files', { timeout: 90_000 }, async t => {
  const c = await start(t, { 'dep.bend': dep, 'main.bend': main, 'closed.bend': closed });
  const caps = c.initialized.capabilities;
  assert.equal(caps.textDocumentSync.change, 1);
  for (const key of ['definitionProvider', 'hoverProvider', 'referencesProvider', 'documentSymbolProvider',
    'workspaceSymbolProvider', 'documentHighlightProvider', 'documentFormattingProvider']) assert.equal(caps[key], true);
  assert.equal(caps.renameProvider.prepareProvider, true);
  assert.equal(caps.signatureHelpProvider, undefined);
  c.open('main.bend');
  const use = c.at('main.bend', main, 'inc(x)');
  const definition = await c.request('textDocument/definition', use);
  assert.equal(definition.uri, c.uri('dep.bend'));
  assert.deepEqual(definition.range.start, { line: 1, character: 4 });
  const hover = await c.request('textDocument/hover', use);
  assert.match(hover.contents.value, /U32/);
  const refs = await c.request('textDocument/references', { ...use, context: { includeDeclaration: false } });
  assert.deepEqual(new Set(refs.map(r => r.uri)), new Set([c.uri('main.bend'), c.uri('closed.bend')]));
  const allRefs = await c.request('textDocument/references', { ...use, context: { includeDeclaration: true } });
  assert.equal(allRefs.length, refs.length + 1);
  const prepared = await c.request('textDocument/prepareRename', use);
  assert.equal(prepared.placeholder, 'inc');
  const rename = await c.request('textDocument/rename', { ...use, newName: 'increment' });
  assert.equal(rename.documentChanges.length, 3);
  for (const change of rename.documentChanges) for (const edit of change.edits) {
    assert.equal(edit.newText, 'increment');
    assert.equal(edit.range.end.character - edit.range.start.character, 3, 'alias prefix is not renamed');
  }
  const local = c.at('main.bend', main, 'x)', 0);
  const localDefinition = await c.request('textDocument/definition', local);
  assert.deepEqual(localDefinition.range.start, { line: 3, character: 10 });
  const localRefs = await c.request('textDocument/references', { ...local, context: { includeDeclaration: true } });
  assert.equal(localRefs.length, 2, 'same-named parameter in another function is not the same binding');
  const localRename = await c.request('textDocument/rename', { ...local, newName: 'value' });
  assert.equal(localRename.documentChanges.length, 1);
  assert.equal(localRename.documentChanges[0].edits.length, 2);
  await assert.rejects(c.request('textDocument/rename', { ...use, newName: 'first' }), /collid|shadow/i);
  await assert.rejects(c.request('textDocument/rename', { ...local, newName: 'return' }), /identifier/i);
  for (const newName of ['Type', 'Data', 'Kind', 'Quant'])
    await assert.rejects(c.request('textDocument/rename', { ...local, newName }), /identifier/i);
  assert.ok(await c.request('textDocument/rename', { ...local, newName: 'if' }),
    'Do not invent reserved words absent from the official compiler.');
  const highlights = await c.request('textDocument/documentHighlight', local);
  assert.equal(highlights.length, 2);
  const completion = await c.request('textDocument/completion', {
    ...use, position: { ...use.position, character: use.position.character + 2 },
  });
  assert.ok(completion.some(item => item.label === 'Dep.inc'));
  const qualified = completion.find(item => item.label === 'Dep.inc');
  assert.equal(qualified.textEdit.newText, 'Dep.inc');
  assert.deepEqual(qualified.textEdit.range, {
    start: { line: 4, character: 2 }, end: { line: 4, character: 9 },
  }, 'Replace the full qualified token, not only the suffix after the dot.');
  const symbols = await c.request('textDocument/documentSymbol', { textDocument: { uri: c.uri('main.bend') } });
  assert.deepEqual(symbols.map(s => s.name).sort(), ['Dep', 'first', 'second']);
  const workspace = await c.request('workspace/symbol', { query: 'closed' });
  assert.ok(workspace.some(s => s.name === 'closed' && s.location.uri === c.uri('closed.bend')));

  const unsaved = '# 😀 an unsaved dependency\n' + dep;
  c.open('dep.bend', unsaved);
  const moved = await c.request('textDocument/definition', use);
  assert.deepEqual(moved.range.start, { line: 2, character: 4 });
  c.notify('textDocument/didClose', { textDocument: { uri: c.uri('dep.bend') } });
  const restored = await c.request('textDocument/definition', use);
  assert.deepEqual(restored.range.start, { line: 1, character: 4 });

  // No watched-files notification: the first request must return a fresh result.
  await writeFile(path.join(c.root, 'dep.bend'), '# disk edit\n' + dep);
  const diskChanged = await c.request('textDocument/definition', use);
  assert.deepEqual(diskChanged.range.start, { line: 2, character: 4 });
});

test('formatting, diagnostics, Unicode offsets, stale edits and shutdown', { timeout: 90_000 }, async t => {
  const source = 'import Base\ndef unicode(x: U32) -> U32:\n  # 😀 UTF-16 positions\n  x\n';
  const c = await start(t, { 'unicode.bend': source });
  c.open('unicode.bend');
  const use = c.at('unicode.bend', source, 'x\n');
  const definition = await c.request('textDocument/definition', use);
  assert.deepEqual(definition.range.start, { line: 1, character: 12 });
  const unformatted = 'import Base\ndef unicode(x:U32)->U32:\n  x\n';
  c.change('unicode.bend', unformatted, 2);
  const formatting = await c.request('textDocument/formatting', {
    textDocument: { uri: c.uri('unicode.bend') }, options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(formatting.length, 1);
  assert.match(formatting[0].newText, /x: U32/);

  c.change('unicode.bend', 'def broken(:\n', 3);
  await c.request('textDocument/documentSymbol', { textDocument: { uri: c.uri('unicode.bend') } });
  assert.ok(c.notifications.some(n => n.method === 'textDocument/publishDiagnostics' &&
    n.params.uri === c.uri('unicode.bend') && n.params.version === 3 && n.params.diagnostics.length));
  c.change('unicode.bend', source, 4);
  await c.request('textDocument/definition', use);
  const diagnostics = c.notifications.filter(n => n.method === 'textDocument/publishDiagnostics' &&
    n.params.uri === c.uri('unicode.bend'));
  assert.equal(diagnostics.at(-1).params.version, 4);
  assert.deepEqual(diagnostics.at(-1).params.diagnostics, []);

  c.change('unicode.bend', '# old\n' + source, 5);
  const obsolete = c.request('textDocument/definition', c.at('unicode.bend', '# old\n' + source, 'x\n'));
  c.change('unicode.bend', '# new\n# new\n' + source, 6);
  const stale = await obsolete;
  assert.ok(stale === null || stale.range.start.line === 3, 'never return an obsolete line-2 definition');
  const latest = await c.request('textDocument/definition', c.at('unicode.bend', '# new\n# new\n' + source, 'x\n'));
  assert.equal(latest.range.start.line, 3);
  c.notify('textDocument/didClose', { textDocument: { uri: c.uri('unicode.bend') } });
  c.change('unicode.bend', source, 7);
  await c.request('shutdown', null);
  c.notify('exit');
  const result = await Promise.race([c.exit, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Server/worker did not terminate')), 3000);
    timer.unref();
  })]);
  assert.equal(result[0], 0);
});

test('rename cannot escape a workspace through an imported symlink', { timeout: 90_000 }, async t => {
  const source = 'import Base\nimport ./link/dep.bend as Dep\ndef main(x: U32) -> U32:\n  Dep.inc(x)\n';
  const c = await start(t, { 'main.bend': source });
  const external = await mkdtemp(path.join(fixtures, 'external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'dep.bend'), dep);
  await symlink(external, path.join(c.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  c.open('main.bend');
  const use = c.at('main.bend', source, 'inc(x)');
  assert.ok(await c.request('textDocument/definition', use), 'External dependency remains navigable.');
  await assert.rejects(c.request('textDocument/rename', { ...use, newName: 'renamed' }), /external|workspace|safely/i);
});

test('oversized workspace files are skipped before reading and disable rename', { timeout: 90_000 }, async t => {
  const c = await start(t, { 'main.bend': dep });
  const huge = await open(path.join(c.root, 'huge.bend'), 'w');
  try { await huge.truncate(1024 * 1024 * 1024); } finally { await huge.close(); }
  c.open('main.bend');
  const use = c.at('main.bend', dep, 'x\n');
  const began = Date.now();
  assert.ok(await c.request('textDocument/definition', use));
  assert.ok(Date.now() - began < 15_000, 'Sparse 1GiB file must not be read or sent to the compiler.');
  await assert.rejects(c.request('textDocument/rename', { ...use, newName: 'value' }), /complete|limit/i);
});

test('rename validates generated do calls with the official compiler before offering edits', { timeout: 90_000 }, async t => {
  const dependency = 'type U is Data:\n  Unit{}\ntype M<-T: Type> is Type:\n  Wrap{value: T}\ndef M.pure(-T: Type, x: T) -> M<T>:\n  Wrap{x}\n';
  const source = 'import ./dep.bend as D\ndef f(x: D.U) -> D.M<D.U>:\n  do D.M<D.U>:\n    return x\n';
  const c = await start(t, { 'main.bend': source, 'dep.bend': dependency });
  c.open('main.bend');
  c.open('dep.bend');
  const alias = c.at('main.bend', source, 'D\n');
  const aliasEdit = await c.request('textDocument/rename', { ...alias, newName: 'E' });
  assert.equal(aliasEdit.documentChanges[0].edits.length, 6);
  const pure = c.at('dep.bend', dependency, 'pure');
  await assert.rejects(c.request('textDocument/rename', { ...pure, newName: 'other' }), /break compiler/i);
});

test('rename refuses a partial workspace instead of returning partial edits', { timeout: 90_000 }, async t => {
  const c = await start(t, { 'dep.bend': dep, 'main.bend': main, 'broken.bend': 'def broken(:\n' });
  c.open('main.bend');
  const use = c.at('main.bend', main, 'inc(x)');
  assert.equal((await c.request('textDocument/definition', use)).uri, c.uri('dep.bend'));
  await assert.rejects(c.request('textDocument/rename', { ...use, newName: 'increment' }), /complete workspace/i);
});
