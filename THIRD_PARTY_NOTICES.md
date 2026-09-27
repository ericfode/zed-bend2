# Third-party notices

## tree-sitter-bend

This extension uses [Amaan Qureshi's Bend2 Tree-sitter grammar](https://github.com/amaanq/tree-sitter-bend),
pinned in `extension.toml`. The highlighting queries are adapted from its
`queries/highlights.scm`, using Zed's capture names and supported predicates.
The upstream package and grammar declare the MIT license.

MIT License

Copyright (c) Amaan Qureshi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Official Bend2 compiler and formatter

`server/vendor/bend.ts`, `base.bend`, and `formatter.ts` originate from
[bendlang/bend](https://github.com/bendlang/bend) at the revision recorded in
`server/vendor/provenance.json`. Copyright 2026 HigherOrderCO.

They are licensed under **Apache-2.0**; the complete license is retained in
`server/vendor/LICENSE`. The compiler has local editor metadata and loader
extensions, marked in its header. Its pattern lowering, normalizer, inference,
and checker are unchanged. The formatter and Base are unmodified.

## Bundled language-server dependencies

The server bundles Microsoft's MIT-licensed `vscode-jsonrpc`,
`vscode-languageserver`, `vscode-languageserver-protocol`,
`vscode-languageserver-textdocument`, and `vscode-languageserver-types`.
Complete dependency licenses, including the compiler's Apache-2.0 license,
are generated into `server/dist/THIRD_PARTY_LICENSES.txt` and installed alongside
the language server by the Zed adapter.

The Rust adapter uses `zed_extension_api` under Apache-2.0 and its transitive
dependencies under their respective licenses; versions are pinned in
`Cargo.lock`.
