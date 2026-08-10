# Stylus Language Server

`stylus-lsp` is a Tree-sitter-based Language Server Protocol implementation for `.styl`, `.stylus`, and Stylus blocks embedded in Vue, Svelte, and Astro components.

## Installation

```sh
npm install --global stylus-lsp
stylus-language-server --stdio
```

Node.js 22 or newer is required.

## Capabilities

- definition and import-path navigation
- lexical references, prepare rename, and conflict-checked workspace rename
- document and workspace symbols
- scope/import-aware completion plus standard CSS property/value data
- static value/signature/documentation hover and signature help
- document colors and color presentations
- syntax, symbol, import, cycle, conflict, and unused-local diagnostics
- incremental parsing, unsaved documents, multi-root workspaces, and file events
- Vue, Svelte, Astro, Quasar 0.17/1/2, Vite, Webpack, Nuxt, aliases, include paths, glob imports, themes, and `node_modules`

## Configuration

Send settings under `stylus` through initialization options or `workspace/didChangeConfiguration`:

```json
{
  "stylus": {
    "aliases": { "tokens": "src/styles/tokens" },
    "includePaths": ["src/styles"],
    "exclude": ["generated/**"],
    "presets": { "quasar": "auto" },
    "themes": {
      "light": "src/themes/light.styl",
      "dark": "src/themes/dark.styl"
    },
    "activeTheme": "dark",
    "diagnostics": {
      "debounceMs": 150,
      "rules": { "unusedLocalVariable": { "severity": "hint" } }
    }
  }
}
```

Vite, Webpack, Nuxt, `tsconfig.json`, and `jsconfig.json` aliases are read statically. Project configuration is never imported or executed; use explicit aliases if a configuration is dynamic.

See the repository's [language-server guide](../../docs/language-server.md) for every setting and diagnostic code.

## Development

```sh
npm install
npm run check
npm test
npm run benchmark -- --sizes=1000,5000,10000
npm pack
```
