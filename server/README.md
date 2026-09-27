# Bend2 language server internals

The server targets official `bendlang/bend`, not the incompatible community
compiler fork. The exact compiler and Base snapshot is recorded in
`vendor/provenance.json`. This is a pinned language version, not an assertion
that every future Bend2 release is compatible.

## Boundaries

- `vendor/bend.ts`: official parser, loader, normalizer, and checker, with local
  editor hooks. The additions collect declaration locations, lexical binding
  identities, references, and scope ranges; loading can use unsaved buffers.
- `src/analyzer.ts`: converts compiler metadata into the source-independent
  protocol in `src/model.ts`, and runs the official checker for diagnostics.
- `src/analysis-worker.ts`: isolates compilation from the LSP event loop.
- `src/server.ts`: implements the LSP features against the semantic index.
- `vendor/formatter.ts`: the official Bend2 formatter, unmodified.
- `../src/lib.rs`: Zed's launcher. It writes the bundled server into the
  extension's own working directory and runs it with Zed's Node.js runtime.

The server never evaluates a project's entry point or foreign imports.
Package resolution is offline: missing packages must be installed through the
normal Bend tooling. An editor must not silently download project dependencies
or write to a user's package cache just because a source file was opened.

Rename is a compiler-checked transaction: source identities select the proposed
edits, scope/collision checks screen them, and a separate worker checks the
edited workspace overlays before any edits are returned. This also protects
implicit references introduced by syntax sugar, which have no written token to
rename. No files are written by this validation.

## Compiler changes

The vendored compiler remains Apache-2.0. Its header describes the local
modifications. Do not casually modify language rules to make an IDE test pass.
The provenance test checks that pattern lowering, normalization, inference, and
checking remain byte-for-byte identical to the pinned upstream source.

The full upstream compiler hash is retained as provenance even though parser
metadata and loader hooks make our full-file hash different. Base, formatter,
and license hashes must still match exactly.

`scripts/vendor-compiler.mjs` imports the pristine snapshot and refuses to
overwrite modified vendor files. It is a bootstrap/reference tool, **not** an
automatic compiler-upgrade command. To upgrade, review upstream changes,
reapply the editor-only changes, update provenance hashes, and run all tests.

## Bundling

```sh
npm ci
npm run build:server
npm run build:server -- --check
npm test
cargo test
```

Generated `dist/` bundles are committed because Zed builds Rust extensions
without running npm. The Rust extension embeds those bundles and Base.
Installation therefore does not require an npm global package or a separate
Bend/compiler checkout. Development requires Node.js 22 or later.

Builds include dependency licenses and no source maps or machine-specific
paths. `--check` fails if source and checked-in bundles disagree.
