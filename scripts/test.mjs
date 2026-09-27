import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, '.build');
const cache = path.join(build, 'tree-sitter-bend');
const output = path.join(build, 'test-grammar');
const configPath = path.join(build, 'tree-sitter-config.json');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, {
  GIT_EDITOR: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  TREE_SITTER_LIBDIR: path.join(build, 'parser-libraries'),
  XDG_CACHE_HOME: path.join(build, 'cache'),
  TMPDIR: path.join(build, 'tmp'), TMP: path.join(build, 'tmp'), TEMP: path.join(build, 'tmp'),
});

function run(command, args, cwd = root) {
  try {
    const result = execFileSync(command, args, {
      cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${error.stdout || ''}${error.stderr || ''}\n${error.message}`);
  }
}
function git(directory, ...args) {
  return run('git', ['-C', directory, '-c', `core.hooksPath=${devNull}`, ...args]);
}
async function exists(location) {
  try { return await lstat(location); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function rejectSymlinks(location) {
  const stat = await exists(location);
  if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink: ${location}`);
  if (stat?.isDirectory()) {
    for (const name of await readdir(location)) await rejectSymlinks(path.join(location, name));
  }
}

async function main() {
  const manifest = await readFile(path.join(root, 'extension.toml'), 'utf8');
  const table = manifest.match(/^\[grammars\.bend\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? '';
  const repository = table.match(/^repository\s*=\s*"(https:\/\/[^"\s]+)"\s*$/m)?.[1];
  const rev = table.match(/^rev\s*=\s*"([a-f0-9]{40})"\s*$/m)?.[1];
  if (!repository || !rev) throw new Error('Expected HTTPS repository and full commit rev in [grammars.bend].');
  await rejectSymlinks(build);
  await mkdir(path.join(build, 'tmp'), { recursive: true });
  if (!await exists(cache)) {
    git(build, 'clone', '--no-checkout', '--template=', repository, cache);
    git(cache, 'fetch', '--depth=1', 'origin', rev);
    git(cache, 'checkout', '--detach', rev);
  }
  // Never reset a dirty or unexpected cache, and never use a linked worktree.
  if (!(await lstat(path.join(cache, '.git'))).isDirectory()
      || git(cache, 'remote', 'get-url', 'origin') !== repository
      || git(cache, 'rev-parse', 'HEAD') !== rev
      || git(cache, 'rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD'
      || git(cache, 'status', '--porcelain')) {
    throw new Error(`Grammar cache must be a clean detached checkout of ${rev} from ${repository}: ${cache}`);
  }
  await rejectSymlinks(cache);
  await rm(output, { recursive: true, force: true });
  await cp(cache, output, { recursive: true, filter: (source) => path.basename(source) !== '.git' });
  const metadataPath = path.join(output, 'tree-sitter.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const grammar = metadata.grammars.find(({ name }) => name === 'bend');
  grammar.highlights = path.join(root, 'languages/bend2/highlights.scm');
  delete grammar.injections;
  delete grammar.locals;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await rm(path.join(output, 'test/highlight'), { recursive: true, force: true });
  await rejectSymlinks(path.join(root, 'test/highlight'));
  await cp(path.join(root, 'test/highlight'), path.join(output, 'test/highlight'), { recursive: true });
  // Commands load the grammar from cwd; do not discover the upstream cache's queries.
  await writeFile(configPath, `${JSON.stringify({ 'parser-directories': [] }, null, 2)}\n`);
  const cli = path.join(root, 'node_modules/tree-sitter-cli/cli.js');
  const treeSitter = (...args) => run(process.execPath, [cli, ...args, '--config-path', configPath], output);
  console.log(treeSitter('test'));
  const examples = (await readdir(path.join(root, 'examples'))).filter((name) => name.endsWith('.bend'))
    .sort().map((name) => path.join(root, 'examples', name));
  if (!examples.length) throw new Error('No examples/*.bend files found.');
  console.log(treeSitter('parse', '--quiet', ...examples));
  for (const name of (await readdir(path.join(root, 'languages/bend2'))).sort()) {
    if (name.endsWith('.scm')) console.log(treeSitter('query', '--quiet', path.join(root, 'languages/bend2', name), ...examples));
  }
  console.log('Bend2 corpus, highlight fixtures, example parses, and queries passed.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
