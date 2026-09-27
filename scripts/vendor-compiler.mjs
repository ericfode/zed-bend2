// Imports the audited official compiler snapshot. Never silently overwrites edits.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const revision = '574b6d39a235b539eb19a5c532993a0abb3d11ad';
const repository = 'https://github.com/bendlang/bend';
const files = {
  'bend.ts': 'bend2/bend.ts',
  'base.bend': 'bend2/base.bend',
  'formatter.ts': 'tools/bend-fmt-lsp/src/formatter.ts',
  'LICENSE': 'LICENSE',
};
const destination = path.join(root, 'server/vendor');
await mkdir(destination, { recursive: true });
const hashes = {};
let trustedKernelSha256;
for (const [name, source] of Object.entries(files)) {
  const response = await fetch(`https://raw.githubusercontent.com/bendlang/bend/${revision}/${source}`);
  if (!response.ok) throw new Error(`${source}: ${response.status}`);
  const contents = await response.text();
  hashes[name] = createHash('sha256').update(contents).digest('hex');
  if (name === 'bend.ts') {
    const boundary = contents.indexOf('export function body_sub(');
    if (boundary < 0) throw new Error('Compiler kernel boundary changed; review the new snapshot.');
    trustedKernelSha256 = createHash('sha256').update(contents.slice(boundary)).digest('hex');
  }
  try {
    const existing = await readFile(path.join(destination, name), 'utf8');
    if (existing !== contents) throw new Error(`Refusing to overwrite modified vendor file: ${name}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path.join(destination, name), contents, { flag: 'wx' });
  }
}
await writeFile(path.join(destination, 'provenance.json'),
  `${JSON.stringify({ repository, revision, files, hashes, trustedKernelSha256 }, null, 2)}\n`);
console.log(`Imported official Bend2 ${revision}`);
