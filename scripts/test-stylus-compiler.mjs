#!/usr/bin/env node

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const grammarDirectory = path.join(root, "vendor", "tree-sitter-stylus");
const require = createRequire(path.join(grammarDirectory, "package.json"));
const stylus = require("stylus");


async function stylusFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await stylusFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".styl")) {
      result.push(entryPath);
    }
  }
  return result.sort();
}


function render(source, filename) {
  return new Promise((resolve, reject) => {
    stylus(source)
      .set("filename", filename)
      .set("paths", [path.dirname(filename)])
      .render((error, css) => error ? reject(error) : resolve(css));
  });
}


const fixtures = await stylusFiles(path.join(root, "examples", "real_world"));
const failures = [];
for (const fixture of fixtures) {
  try {
    await render(await fs.readFile(fixture, "utf8"), fixture);
  } catch (error) {
    failures.push(`${path.relative(root, fixture)}: ${error.message}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`error: ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Compiled ${fixtures.length} real-world fixtures with Stylus ${require("stylus/package.json").version}`);
}
