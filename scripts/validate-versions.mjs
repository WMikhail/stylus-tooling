#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (relativePath) =>
  JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
const readText = (relativePath) => fs.readFile(path.join(root, relativePath), "utf8");

function topLevelTomlVersion(source, label) {
  const match = /^version\s*=\s*"([^"]+)"\s*$/m.exec(source);
  if (!match) throw new Error(`${label} does not declare a top-level version`);
  return match[1];
}

const [
  rootManifest,
  serverManifest,
  packageLock,
  extensionToml,
  cargoToml,
  extensionReadme,
] = await Promise.all([
  readJson("package.json"),
  readJson("packages/language-server/package.json"),
  readJson("package-lock.json"),
  readText("editors/zed/extension.toml"),
  readText("editors/zed/Cargo.toml"),
  readText("editors/zed/README.md"),
]);

const versions = new Map([
  ["package.json", rootManifest.version],
  ["packages/language-server/package.json", serverManifest.version],
  ["editors/zed/extension.toml", topLevelTomlVersion(extensionToml, "extension.toml")],
  ["editors/zed/Cargo.toml", topLevelTomlVersion(cargoToml, "Cargo.toml")],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root workspace", packageLock.packages?.[""]?.version],
  [
    "package-lock.json language-server workspace",
    packageLock.packages?.["packages/language-server"]?.version,
  ],
]);
const expected = serverManifest.version;
const errors = [];
for (const [file, version] of versions) {
  if (version !== expected) {
    errors.push(`${file} has version ${version ?? "<missing>"}; expected ${expected}`);
  }
}

if (packageLock.packages?.["packages/language-server"]?.name !== serverManifest.name) {
  errors.push("package-lock.json has a stale language-server package name");
}

const marketplaceVersion = /\nversion\s*=\s*"([^"]+)"/.exec(extensionReadme)?.[1];
if (marketplaceVersion !== expected) {
  errors.push(
    `editors/zed/README.md marketplace example has version ${marketplaceVersion ?? "<missing>"}; expected ${expected}`,
  );
}

const tagArgument = process.argv.find((argument) => argument.startsWith("--tag="));
const releaseTag =
  tagArgument?.slice("--tag=".length) ??
  (process.env.GITHUB_REF_NAME?.startsWith("language-server-v")
    ? process.env.GITHUB_REF_NAME
    : null);
if (releaseTag && releaseTag !== `language-server-v${expected}`) {
  errors.push(`release tag ${releaseTag} does not match language-server-v${expected}`);
}

if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`all release surfaces use version ${expected}`);
}
