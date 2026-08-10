# Stylus tooling 0.6.0

This release completes the 0.2–0.6 language-server roadmap. All language features now share the Tree-sitter semantic model and work with unsaved standalone/component documents. Framework configuration is statically analyzed and never executed. The workspace index updates one document and its reverse dependencies rather than rebuilding the workspace.

The release package contains the portable Stylus grammar WASM and is validated by packing, installing, and launching it in a clean project. CI covers macOS, Linux, Windows, current Node LTS, Rust stable, and `wasm32-wasip2`.

See [language-server.md](language-server.md), [architecture.md](architecture.md), and [performance.md](performance.md) for settings, internals, measured results, and known limits.
