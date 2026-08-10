# Stylus language server

The server uses the repository's `tree-sitter-stylus` grammar through a portable WASM runtime. Syntax nodes are mapped into one shared semantic model used by definition, references, rename, symbols, completion, hover, signature help, colors, and diagnostics.

## Supported documents

- `.styl` and `.stylus`
- every `<style lang="stylus">` or `<style lang="styl">` block in Vue SFCs
- Stylus style blocks in Svelte and Astro components
- unsaved open-document contents, including excluded or not-yet-created files

Vue extraction uses `@vue/compiler-sfc`; Astro extraction uses `@astrojs/compiler`. Embedded offsets are translated back to host ranges in UTF-16 code units, so other language servers can continue serving the template and script regions of the same component.

## Language features

The semantic model indexes variables, functions, mixins, parameters, loop variables, selectors, placeholder selectors, and keyframes. File, function/mixin, loop, and nested block scopes retain declaration order and parent relationships. A local declaration wins over imported or workspace symbols, while shadowed names in independent scopes remain separate.

Navigation follows relative imports, `.styl`/`.stylus` extensions, `index` files, include paths, aliases, glob imports, `node_modules`, webpack-compatible `~`, active themes, and transitive chains. Import cycles are bounded and diagnosed.

Completion ranks the innermost lexical declarations first, direct imports before transitive imports, and active-theme symbols with imports. CSS property and value entries come from `vscode-css-languageservice`, not a hand-maintained list.

Hover is static: it shows a stored expression/value, signature, adjacent comments, definition URI, and imported origin without running Stylus code.

## Settings

All settings live under `stylus`:

```json
{
  "stylus": {
    "aliases": {
      "tokens": "src/css/tokens",
      "theme": ["src/themes/current.styl", "src/themes/fallback.styl"]
    },
    "includePaths": ["src/css", "src/styles"],
    "allowAbsolutePaths": false,
    "presets": { "quasar": "auto" },
    "autoDetectAliases": true,
    "exclude": ["generated/**", "archive/**"],
    "maxFileSize": 2097152,
    "maxImportDepth": 64,
    "maxGlobMatches": 10000,
    "maxGlobDirectories": 10000,
    "maxGlobEntries": 100000,
    "maxGlobDepth": 64,
    "maxBraceExpansions": 256,
    "maxWorkspaceDirectories": 10000,
    "maxWorkspaceEntries": 250000,
    "maxWorkspaceFiles": 100000,
    "maxWorkspaceDepth": 64,
    "maxCompletionEntries": 10000,
    "completionLimit": 200,
    "themes": {
      "light": "src/themes/light.styl",
      "dark": "src/themes/dark.styl"
    },
    "activeTheme": "dark",
    "workspaces": {
      "packages/admin": {
        "aliases": { "tokens": "src/admin-tokens" },
        "includePaths": ["src/styles"]
      }
    },
    "diagnostics": {
      "enabled": true,
      "debounceMs": 150,
      "rules": {
        "unknownVariable": { "severity": "warning" },
        "unusedLocalVariable": { "severity": "hint" },
        "unknownMixin": false
      }
    }
  }
}
```

Alias/include targets are relative to the nearest configured package root. `workspaces` keys may be absolute paths, file URIs, or paths relative to a workspace root. Absolute imports are rejected unless `allowAbsolutePaths` is true.

Glob, workspace, and completion settings are resource budgets rather than guarantees that every matching file or directory will be visited. `maxWorkspace*` bounds initial indexing, `maxCompletionEntries` bounds directory entries inspected for one import completion, and `completionLimit` bounds returned items. The server reports truncated workspace scans, marks truncated completion lists as incomplete, rejects oversized or combinatorially expensive patterns before matching, and applies hard upper bounds to every numeric limit.

The Quasar preset accepts `true`, `false`, `"on"`, `"off"`, or `"auto"`. Auto mode checks the nearest `package.json` and `.quasar` without affecting ordinary projects. It recognizes Quasar 0.17 (`quasar-framework`) and Quasar 1/2 packages. Generated `.quasar/variables.styl` is modeled as the framework's implicit, lowest-priority import, matching the variables that Quasar injects into component Stylus blocks.

## Safe configuration discovery

The server statically reads object-literal aliases from Vite, Webpack, and Nuxt configuration plus `baseUrl`/`paths` from `tsconfig.json` and `jsconfig.json`. Supported expressions are literals, arrays, objects, constants, `defineConfig`, `defineNuxtConfig`, and literal `path.resolve`/`path.join` calls. Dynamic functions and calls are never evaluated; the server logs a message requesting explicit `stylus.aliases` instead.

Missing optional files are treated as absent. Other filesystem failures, such as permission or I/O errors, are surfaced with the operation and affected path instead of being silently treated as missing files.

## Diagnostic codes

| Code                            | Default severity |
| ------------------------------- | ---------------- |
| `stylus.syntax-error`           | error            |
| `stylus.vue-parse-error`        | error            |
| `stylus.unresolved-import`      | error            |
| `stylus.unknown-variable`       | warning          |
| `stylus.unknown-function`       | warning          |
| `stylus.unknown-mixin`          | warning          |
| `stylus.unknown-keyframes`      | warning          |
| `stylus.cyclic-import`          | warning          |
| `stylus.conflicting-definition` | warning          |
| `stylus.unused-local-variable`  | hint             |

Rule keys accept either the full code or camelCase suffix. Severities are `error`, `warning`, `information`, or `hint`; `false`/`off` disables a rule. Diagnostics are deduplicated, debounced, recalculated for reverse dependencies, and cleared after fixes. Stylelint remains responsible for stylistic/CSS lint rules.

Calls provided by standard CSS data, such as `rotate()`, `translateX()`, and `calc()`, are not reported as unknown Stylus functions.

## Known limits

- Dynamically constructed import specifiers cannot be resolved statically.
- Dynamic JavaScript/TypeScript configuration intentionally requires explicit LSP settings.
- Hover reports a source expression when a value cannot be determined without executing Stylus.
- Rename refuses ambiguous targets or any change that would bind a reference to a different local/imported symbol.
