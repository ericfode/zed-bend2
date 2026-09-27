# Bend2 syntax highlighting for Zed

A Zed language extension for **Bend2**, the current
[Bend language](https://github.com/bendlang/bend). It uses a pinned revision of
[amaanq/tree-sitter-bend](https://github.com/amaanq/tree-sitter-bend), which follows
the Bend2 compiler and guide—not the older Bend1 grammar.

Source and releases: **https://github.com/ericfode/zed-bend2**

This extension is currently distributed as a **dev extension**, not through
Zed's extension catalog. Automated parser/highlight tests pass; a manual Zed
smoke test is still required before catalog submission.

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
   Zed downloads the pinned grammar and builds it to WebAssembly. Its first
   build also downloads the WASI SDK if needed.
4. Open a `.bend` file. The language selector should show **Bend2**.
   `examples/highlighting.bend` is a visual smoke-test fixture.

You do **not** need Node.js, npm, custom Rust extension code, or a language server
to install this extension.

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

## Included

- `.bend` file detection, `#` comments, and two-space indentation.
- Highlighting for functions, types, constructors, parameters, fields, imports,
  strings and escapes, chars, numbers, operators, and comments.
- Bend2-specific highlighting for `law` / `for` / `exs` / `where`, equality
  proofs and rewrites, holes, quantities, templates, `do` blocks, and GPU calls.
- Bracket matching, auto-closing delimiters, indentation queries, and an outline
  of functions, laws, types, and constructors.
- Standard Zed theme captures; no custom theme required.

This is **syntax support**, not a compiler integration: it does not provide
type checking, completion, formatting, or go-to-definition. The grammar is
pinned for reproducibility, so future Bend2 syntax changes may require updating
the pin and queries. The examples exercise syntax and are not type-checked
programs.

## Development and tests

Requirements: Node.js 22+, npm, Git, and a C compiler.

```sh
npm ci
npm test
```

Tests download the **exact grammar revision in `extension.toml`** into `.build/`,
compile its native parser, run its corpus plus our highlight assertions, parse
the examples, and validate the Zed queries. The first run requires network access;
subsequent runs reuse the pinned checkout. Generated files are ignored by Git.

The extension's source of truth is:

- `extension.toml`: grammar repository and revision.
- `languages/bend2/config.toml`: language registration and editor defaults.
- `languages/bend2/*.scm`: Zed highlight, bracket, outline, and indentation queries.
- `test/highlight/`: regression tests for the theme captures.

## License

MIT; see `LICENSE`.
Upstream attribution and license information are in `THIRD_PARTY_NOTICES.md`.
