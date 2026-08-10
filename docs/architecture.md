# Language-server architecture

The server separates transport from analysis:

- `parser.mjs` owns portable Tree-sitter runtime initialization, incremental edits, and syntax-tree lifetimes.
- `syntax-queries.mjs` defines the Tree-sitter query boundary.
- `embedded-documents.mjs` extracts component styles and maps UTF-16 host/local ranges.
- `semantic-model.mjs` builds symbols, scopes, references, imports, and syntax errors.
- `import-resolver.mjs` resolves paths through a standalone API and isolated presets.
- `glob-utils.mjs` validates glob complexity before matching.
- `static-configuration.mjs` safely reads aliases without executing configuration.
- `workspace-scanner.mjs` performs bounded, ignore-aware workspace traversal.
- `workspace-graph.mjs` owns import and reverse-dependency edges.
- `workspace-symbol-index.mjs` owns the cross-document symbol lookup.
- `workspace-document-store.mjs` owns host documents, unsaved overlays, symbol-index updates, and syntax-tree disposal.
- `resolution-cache.mjs` owns per-document and workspace-fallback cache buckets.
- `document-update-coordinator.mjs` serializes per-document changes, cancels superseded parses, and deduplicates file loads.
- `workspace-settings.mjs` validates configuration and applies hard resource ceilings.
- `workspace-index.mjs` orchestrates the document store, update coordinator, graph, resolver, and feature services.
- `workspace-authoring.mjs` owns completion, hover, signatures, symbols, and color features.
- `workspace-navigation.mjs` owns definitions, references, and safe rename.
- `authoring.mjs` supplies CSS data, color conversion, and completion/signature helpers.
- `diagnostics.mjs` creates stable configurable diagnostics.
- `diagnostics-scheduler.mjs` debounces diagnostics and cancels superseded computations.
- `filesystem-errors.mjs` distinguishes absent paths from reportable filesystem failures.
- `background-tasks.mjs` supervises deliberately detached work and reports every failure.
- `server.ts` contains only LSP capability registration, document events, cancellation adapters, and diagnostic publication.

Each open host document can own multiple embedded documents. A change supersedes queued stale text and cancels an older active parse before it is queued behind the same host's tail. The winning change incrementally reparses matching embedded regions, atomically replaces its semantic models, and invalidates resolution cache buckets for that document plus reverse dependents. File I/O occurs outside global locks; independent documents parse with independent parser instances.

Workspace and static-configuration scans stream directory entries and obey `.gitignore`, explicit excludes, directory, entry, and depth limits. Source indexing additionally enforces size and file-count limits across multiple roots and nearest-package configuration. Initial indexing uses bounded concurrent I/O. Import completion and glob imports have separate entry/traversal budgets; relative and sibling globs cannot leave their workspace. Imported sources outside the scan (for example `node_modules`) are indexed on demand, with graph depth and cycle protection.

Plain Stylus startup does not load component compilers or TypeScript. Vue and Astro compilers are imported only for their host file types, and TypeScript is imported only after a supported project configuration is found.

JavaScript sources are checked with `noImplicitAny`. Generated declarations preserve the semantic contracts for documents, symbols, references, settings, and feature results instead of erasing them to `any`.
