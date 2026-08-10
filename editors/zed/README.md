# Stylus for Zed

Stylus language support for [Zed](https://zed.dev/), powered by a dedicated
Tree-sitter grammar and the `stylus-lsp` npm package.

## Features

- `.styl` and `.stylus` file detection
- syntax highlighting, indentation, brackets, outline, and text objects
- snippets for common Stylus constructs
- semantic navigation, references, rename, completion, hover, colors, and diagnostics
- Stylus embeddings in Vue, Svelte, and Astro
- automatic language-server installation and updates through Zed

## Development installation

Run `zed: install dev extension` and select the `editors/zed` directory, not the
monorepository root. Re-run `zed: rebuild dev extension` after changing the Rust
adapter or manifest.

### Local language-server override

To test unpublished language-server changes, build the local package:

```sh
npm run build --workspace packages/language-server
```

Then add an absolute path to Zed's settings:

```json
{
  "lsp": {
    "stylus-language-server": {
      "binary": {
        "path": "/absolute/path/to/stylus/packages/language-server/dist/server.js",
        "arguments": ["--stdio"]
      }
    }
  }
}
```

The adapter recognizes JavaScript overrides and still uses Zed's managed Node.js
binary. Remove `binary` to test the released package; the extension installs and
caches `stylus-lsp` automatically.

Project-specific aliases and include paths belong under the same server's
`settings` field. See the
[language-server guide](../../docs/language-server.md#optional-settings).

## Marketplace packaging

When submitting the parent repository to `zed-industries/extensions`, use:

```toml
[stylus]
submodule = "extensions/stylus"
path = "editors/zed"
version = "0.6.0"
```

The extension path contains its own MIT license and never ships the language
server source or build output.
