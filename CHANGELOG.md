# Changelog

## 0.6.1

- Fixed compact declarations and semicolon handling, space-separated parenthesized lists, continued values, percentage casts, and modulo expressions.
- Resolved calls through variables and parameters, including definition, references, rename, and builtin function values in assignments and parameter defaults.
- Recognized CSS counter names and custom counter styles in `counter()` and `counters()` without unknown-variable warnings.
- Fixed mixed root indentation in embedded styles and ignored comment-only indentation, including trailing comments without a newline and braces inside comments and strings.
- Preserved grouped pseudo-selectors and HEX-like ID selectors while retaining HEX color types and highlighting.
- Added combined `/deep/` and `>>>` selectors and vendor-prefixed keyframes without false conflicts between prefixed and standard definitions.
- Reported missing closing punctuation in incomplete CSS blocks and refreshed the packaged grammar WASM.
- Updated the transitive `brace-expansion` dependency to 5.0.12 to address high-severity denial-of-service advisories.

## 0.6.0

- Added Vue, Svelte, Astro, Quasar 1/2, Vite, Webpack, Nuxt, multi-root, monorepo, package-specific settings, static aliases, themes, `.gitignore`, and excludes.
- Added Quasar 0.17 detection, implicit generated variables, and dotted Stylus import resolution for paths such as `common.variables`.
- Added incremental syntax/semantic caches, import and reverse-dependency graphs, targeted invalidation, cancellation, limits, instrumentation, and 1k/5k/10k benchmarks.
- Split scanning, settings, symbols, graph, authoring, and navigation ownership out of the workspace coordinator; enabled strict JavaScript type checking without declaration-level `any` and supervised detached server tasks.
- Bounded glob traversal and brace expansion, restricted relative glob imports to the workspace, and updated `minimatch` to the patched release.
- Bounded initial workspace scans and import completion traversal, with incomplete/truncation reporting.
- Fixed package-specific configuration precedence and validation.
- Coalesced rapid document updates and cancelled superseded parses and diagnostics.
- Surfaced non-missing filesystem failures with operation and path context.
- Normalized component-level indentation before parsing Vue, Svelte, and Astro style blocks while preserving host offsets.
- Recognized standard CSS calls such as `rotate()` in semantic diagnostics.
- Raised the runtime floor to Node.js 22 and added production dependency audits plus weekly npm and GitHub Actions updates.
- Added unit, golden, fixture, full stdio end-to-end, package-install, cross-platform Node, Rust stable, and `wasm32-wasip2` CI gates.

## 0.5.0

- Added configurable syntax, unresolved import, unknown variable/function/mixin/keyframes, cycle, conflict, and unused-local diagnostics with stable codes and debounce.

## 0.4.0

- Added scoped/import-aware completion, standard CSS data, static hover, nested signature help, document colors, and color presentations.

## 0.3.0

- Added lexical references, prepare rename, safe cross-file rename, document/workspace symbols, selector extension navigation, and incremental file lifecycle updates.

## 0.2.0

- Replaced structural regex scanning with Tree-sitter WASM, queries, incremental parsing, explicit scopes/symbols, UTF-16 mappings, compiler-based Vue SFC embeddings, a standalone import resolver, Quasar preset, and semantic definition navigation.
