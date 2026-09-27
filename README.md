# Bend2 language support for Zed

A Zed extension for **official [Bend2](https://github.com/bendlang/bend)**, with
Tree-sitter highlighting and a bundled, compiler-backed language server.
It does not use the older Bend1 grammar or the community LSP's compiler fork.

The compiler and Base are pinned to
[`574b6d39`](https://github.com/bendlang/bend/tree/574b6d39a235b539eb19a5c532993a0abb3d11ad).
Editor hooks collect source locations and binding identities while leaving
the official normalizer and type checker unchanged.

Source and releases: **https://github.com/ericfode/zed-bend2**

This extension is currently distributed as a **dev extension**, not through
Zed's extension catalog. A manual Zed smoke test is still required before catalog
submission.

## Install in Zed

Clone the repository to a persistent directory:

```sh
git clone https://github.com/ericfode/zed-bend2.git
```

1. Use a current Zed release. Have Git available and follow Zed's
   [dev-extension prerequisites](https://zed.dev/docs/extensions/developing-extensions)
   (including Rust installed through `rustup`).
2. In Zed's command palette, run **`zed: install dev extension`**.
3. Select the cloned **`zed-bend2` directory**, containing `extension.toml`.
   Zed builds the Rust adapter and grammar to WebAssembly. Its first build
   downloads the Rust WASI target and WASI SDK if needed.
4. Open a `.bend` file. The language selector should show **Bend2**.
   Zed starts the bundled server automatically, using Node.js **22 or later**.

Zed manages the Node.js runtime. No global npm package, separately installed
language server, or Bend compiler checkout is required. If Zed reports an older
Node runtime, update Zed or configure its Node runtime to use Node.js 22+.
The committed server bundles let Zed build the extension without running npm.

### Try the editor features

Open **`examples/project` as its own Zed project**, then open `main.bend`:

- Go to definition on `Math.increment` to open its declaration in `math.bend`.
- Go to definition on the final `result` to find its local binding.
- Hover a function, complete `Math.`, find references, or rename `increment`.
- Introduce a type error and inspect the compiler diagnostic; undo it afterward.
- Run Zed's format command to use the official Bend2 formatter.

`examples/highlighting.bend` is a separate **syntax-only** showcase, not a
type-checked program. It intentionally exercises incomplete proofs and other
constructs that can produce diagnostics.

### If the older Bend extension is installed

Uninstall the older **Bend** extension first: it targets Bend1 and claims the
same `.bend` suffix and grammar name. If language detection still picks the
wrong language, select **Bend2** in the status bar or add this to your Zed settings:

```json
{
  "file_types": {
    "Bend2": ["**/*.bend"]
  }
}
```

### Updating or troubleshooting

Run `git pull --ff-only` in your clone to get updates, then rebuild the extension
from Zed's Extensions page. Also rebuild after changing the queries locally.
If installation fails, use **`zed: open log`** for the build error.
Keep this checkout available while the dev extension is installed.

For language-server problems, inspect Zed's language-server logs and restart
the Bend2 server after rebuilding. If you previously installed the copied
syntax-only extension at `~/.local/share/zed-bend2`, install this checkout as the
dev extension instead; that older copy does not acquire new files automatically.

## Language features

| Feature | Support |
| --- | --- |
| Go to definition | Compiler-resolved declarations, imported symbols, local binders, types and constructors |
| Hover | Declaration signatures and available declared local types |
| Completion | Compiler-visible names, including qualified imports and scoped locals |
| Find references / document highlights | Resolved symbol identities; references include closed workspace files |
| Rename | Collision checks and compiler revalidation before returning edits; refuses incomplete indices and external declarations |
| Document / workspace symbols | Indexed declarations |
| Diagnostics | Official compiler parse/type errors against unsaved buffers and imports |
| Formatting | Official Bend2 formatter |

The server uses **UTF-16 positions** and open-buffer overlays. Compilation runs
in an isolated worker, with timeouts and stale-result checks so older edits do
not overwrite newer results.

### Editor syntax features

- `.bend` file detection, `#` comments, and two-space indentation.
- Highlighting for functions, types, constructors, parameters, fields, imports,
  strings and escapes, chars, numbers, operators, and comments.
- Bend2-specific highlighting for `law` / `for` / `exs` / `where`, equality
  proofs and rewrites, holes, quantities, templates, `do` blocks, and GPU calls.
- Bracket matching, auto-closing delimiters, indentation queries, and an outline
  of functions, laws, types, and constructors.
- Vim function/type text objects and string/comment syntax scopes.
- Standard Zed theme captures; no custom theme required.

### Boundaries

This is not a debugger or a claim that every LSP feature is implemented.
Signature help, code actions, semantic tokens, and general inferred local-type
hover are not currently provided.

- Missing package dependencies are **not downloaded by the editor**. Install
  packages with Bend tooling; the server uses the local `BEND_LIB` cache
  (normally `~/.bend/lib`). Source files and foreign imports are never executed.
- The official checker reports its first error. A malformed top-level declaration
  is omitted from the partial index while earlier accepted declarations remain
  available. Rename is disabled while any workspace analysis is incomplete.
- Workspace scans are bounded (1,000 files, 16 MiB of source, 10,000 directory
  entries); each compilation also caps dependency loading at 256 sources and
  2 MiB per file. Open the relevant project directory rather than a home
  directory or a collection of unrelated projects.
- Dependencies outside the workspace, including bundled Base, are navigable
  but read-only for rename.
- Future Bend2 syntax/compiler changes require updating the pinned snapshot
  and tests. Protocol and build tests have been run on macOS; the included CI
  workflow targets Linux. Manual Zed UI validation remains separate.

### Custom server

Developers can explicitly override the bundled server in Zed settings:

```json
{
  "lsp": {
    "bend2": {
      "binary": {
        "path": "/absolute/path/to/node",
        "arguments": ["/absolute/path/to/server.mjs", "--stdio"]
      }
    }
  }
}
```

The extension never silently discovers a different `bend2-lsp` on `PATH`.
`binary.arguments` replaces the default arguments.

## Development and tests

Requirements: Node.js 22+, npm, Git, a C compiler, and Rust.

```sh
npm ci
npm run build:server
npm run typecheck
npm test
cargo test --locked
cargo build --release --target wasm32-wasip2
```

Syntax tests download the **exact grammar revision in `extension.toml`** into
`.build/`, run its corpus plus our highlight assertions, and validate the Zed
queries. Server tests exercise compiler analysis and real framed stdio LSP
requests, including imports, unsaved buffers, shadowing, rename, and diagnostics.
The provenance test protects the official compiler kernel from accidental edits.

`npm run build:server -- --check` verifies that committed bundles match source.
See `server/README.md` for compiler provenance, architecture, and maintenance.

The extension's source of truth is:

- `extension.toml`: grammar repository and revision.
- `languages/bend2/config.toml`: language registration and editor defaults.
- `languages/bend2/*.scm`: Zed highlight, bracket, outline, and indentation queries.
- `test/highlight/`: regression tests for the theme captures.
- `server/src/`: compiler integration and LSP implementation.
- `src/lib.rs`: Zed's bundled-server launcher.
- `test/server/`: semantic and protocol regression tests.

## License

Extension and server integration: MIT; see `LICENSE`.
Vendored official compiler, Base, and formatter: Apache-2.0.
Upstream attribution and license information are in `THIRD_PARTY_NOTICES.md`.
