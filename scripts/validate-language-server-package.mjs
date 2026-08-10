#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "packages", "language-server", "package.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const adapter = await fs.readFile(
  path.join(root, "editors", "zed", "src", "stylus.rs"),
  "utf8",
);
const release = process.argv.includes("--release");
const errors = [];

if (manifest.name !== "stylus-lsp") {
  errors.push("package name must be stylus-lsp");
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
  errors.push("package version must use MAJOR.MINOR.PATCH semantic versioning");
}
if (manifest.private === true) {
  errors.push("language-server package must not be private");
}
if (manifest.bin?.["stylus-language-server"] !== "dist/server.js") {
  errors.push("package bin must point to dist/server.js");
}
if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
  errors.push("package files must include dist");
}
if (!manifest.files?.includes("assets")) {
  errors.push("package files must include the portable Tree-sitter assets");
}
if (manifest.files?.some((entry) => entry === "src" || entry === "tests")) {
  errors.push("package files must not include sources or tests");
}
if (manifest.license !== "MIT") {
  errors.push("package license must be MIT");
}
if (manifest.publishConfig?.access !== "public") {
  errors.push("publishConfig.access must be public");
}
if (manifest.publishConfig?.provenance !== true) {
  errors.push("publishConfig.provenance must be true");
}
if (!manifest.dependencies?.["vscode-languageserver"]) {
  errors.push("vscode-languageserver must be a runtime dependency");
}
if (!manifest.dependencies?.["web-tree-sitter"]) {
  errors.push("web-tree-sitter must be a runtime dependency");
}
if (manifest.dependencies?.svelte) {
  errors.push("unused svelte compiler must not be a runtime dependency");
}
if (!adapter.includes(`const PACKAGE_NAME: &str = "${manifest.name}";`)) {
  errors.push("Zed adapter package name must match the npm manifest");
}
if (!adapter.includes('const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");')) {
  errors.push("Zed adapter must pin the npm package to the extension version");
}
if (adapter.includes("npm_package_latest_version")) {
  errors.push("Zed adapter must not install an independently moving latest version");
}

if (release) {
  const repository =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
  if (
    typeof repository !== "string" ||
    !/^(?:git\+)?https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(repository)
  ) {
    errors.push("release package needs a public HTTPS GitHub repository");
  }
  if (/(?:owner|username|your-name)/i.test(repository ?? "")) {
    errors.push("package repository still contains a placeholder");
  }
  if (typeof manifest.homepage !== "string" || !manifest.homepage.startsWith("https://")) {
    errors.push("release package needs an HTTPS homepage");
  }
  if (typeof manifest.bugs?.url !== "string" || !manifest.bugs.url.startsWith("https://")) {
    errors.push("release package needs an HTTPS bug tracker URL");
  }
}

if (errors.length) {
  for (const error of errors) {
    console.error(`error: ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `language-server package passed ${release ? "release" : "development"} validation`,
  );
}
