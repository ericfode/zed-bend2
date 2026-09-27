import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const vendor = path.join(root, 'server/vendor');
const hash = (text) => createHash('sha256').update(text).digest('hex');

test('official compiler kernel, Base, formatter and license retain pinned provenance', async () => {
  const provenance = JSON.parse(await readFile(path.join(vendor, 'provenance.json'), 'utf8'));
  assert.equal(provenance.repository, 'https://github.com/bendlang/bend');
  assert.match(provenance.revision, /^[0-9a-f]{40}$/);
  for (const name of ['base.bend', 'formatter.ts', 'LICENSE']) {
    assert.equal(hash(await readFile(path.join(vendor, name))), provenance.hashes[name], name);
  }
  const compiler = await readFile(path.join(vendor, 'bend.ts'), 'utf8');
  const boundary = compiler.indexOf('export function body_sub(');
  assert.ok(boundary > 0);
  assert.equal(hash(compiler.slice(boundary)), provenance.trustedKernelSha256,
    'Pattern lowering, normalization, inference and checker must remain byte-for-byte official.');
});
