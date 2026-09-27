import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('launcher rejects old Node before importing any server dependencies', async t => {
  const fixtures = path.join(root, '.build', 'startup tests');
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(path.join(fixtures, 'runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launcher = path.join(directory, 'launcher.mjs');
  await cp(path.join(root, 'server/dist/launcher.mjs'), launcher);
  // Deliberately no server.mjs beside the launcher. A premature import would
  // report a missing module instead of the actionable version requirement.
  for (const version of ['20.19.0', '21.7.3', 'unknown']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
       await import(${JSON.stringify(pathToFileURL(launcher).href)});`,
    ], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '', 'Never corrupt LSP stdout with startup messages.');
    assert.match(result.stderr, /Bend2 requires Node\.js 22 or newer/);
    assert.ok(result.stderr.includes(version));
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  }
});

test('Zed startup needs no extra process execution permission', async () => {
  const adapter = await readFile(path.join(root, 'src/lib.rs'), 'utf8');
  const manifest = await readFile(path.join(root, 'extension.toml'), 'utf8');
  assert.doesNotMatch(adapter, /(?:zed|std)::process::Command/);
  assert.doesNotMatch(manifest, /process:exec/);
  assert.match(adapter, /include_bytes!\("\.\.\/server\/dist\/launcher\.mjs"\)/);
  assert.match(adapter, /directory\s*\.join\("launcher\.mjs"\)/);
});
