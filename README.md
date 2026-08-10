# Stylus Tooling

Language tooling for Stylus, including a publishable language server and the
Stylus extension for [Zed](https://zed.dev/).

## Repository layout

- `packages/language-server` — the `stylus-lsp` npm package
- `editors/zed` — the Zed extension, isolated from the language-server package
- `vendor/tree-sitter-stylus` — a local checkout of the separately maintained
  Tree-sitter grammar, ignored by Git
- `examples` and `tests` — shared grammar and integration fixtures

Zed's marketplace package is rooted at `editors/zed`. It contains the language
configuration, grammar queries, snippets, and Rust adapter, but not the language
server. The adapter installs the versioned server from npm into Zed's extension
work directory and launches it with Zed's managed Node.js runtime.

## Current capabilities

- Stylus syntax highlighting, indentation, outline, text objects, brackets, and
  snippets
- Tree-sitter semantic analysis with explicit file, callable, loop, and block
  scopes; parameters, shadowing, selectors, placeholders, and keyframes
- definition, references, safe rename, document/workspace symbols, completion,
  hover, signature help, colors, and configurable semantic diagnostics
- `.styl`, `.stylus`, Vue SFC, Svelte, Astro, Quasar 0.17/1/2, Vite, Webpack, Nuxt,
  monorepo, and multi-root workspace support
- relative, alias, include-path, glob, `node_modules`, `index.styl`, theme, and
  import-chain resolution
- incremental syntax/semantic caches, import and reverse-dependency graphs,
  unsaved overlays, superseded-work cancellation, targeted invalidation,
  bounded `.gitignore`-aware scans, and excludes

## Development

Install the root workspace and grammar dependencies:

```sh
npm install
npm install --prefix vendor/tree-sitter-stylus
./scripts/check.sh
```

Development and the published language server require Node.js 22 or newer.

The full check compiles the TypeScript server, exercises its LSP protocol,
packs and installs the npm tarball in a clean directory, checks the Rust adapter,
rebuilds and compares the packaged grammar WASM, and runs all Tree-sitter and
Stylus fixtures. After changing the grammar, refresh the binary with
`./scripts/sync-language-server-wasm.sh`.

Focused language-server commands:

```sh
npm run format:check --workspace packages/language-server
npm run lint --workspace packages/language-server
npm run test:unit --workspace packages/language-server
npm run test:integration --workspace packages/language-server
npm run test:golden --workspace packages/language-server
npm run test:e2e --workspace packages/language-server
npm run benchmark:lsp -- --sizes=1000,5000,10000
```

To test local Zed adapter or language-server changes:

1. Run `npm run build` from the repository root.
2. Configure the local server path as shown in
   [`editors/zed/README.md`](editors/zed/README.md#local-language-server-override).
3. Run `zed: install dev extension` and select `editors/zed`.

Without a local binary override, the adapter installs the released
`stylus-lsp@0.6.0` package from npm.

## Releasing

The language server is published as the public npm package `stylus-lsp`.
`npm pack --workspace packages/language-server` produces
the same artifact exercised by the package smoke test.

Public GitHub repository metadata is validated before running:

```sh
npm run check:release
```

After that, the Zed extension can be added to `zed-industries/extensions` with
`path = "editors/zed"`.

## Documentation

- [Language-server behavior and settings](docs/language-server.md)
- [Language-server architecture](docs/architecture.md)
- [Performance measurements](docs/performance.md)
- [Changelog](CHANGELOG.md)
- [Stylelint integration](docs/stylelint.md)
- [Zed extension details](editors/zed/README.md)

## License

Licensed under the [MIT License](LICENSE).
