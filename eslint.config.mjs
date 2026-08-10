import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = Object.fromEntries(
  [
    "AbortController",
    "Buffer",
    "URL",
    "clearTimeout",
    "console",
    "process",
    "setTimeout",
  ].map((name) => [name, "readonly"]),
);

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "grammars/**",
      "packages/language-server/tests/fixtures/**",
      "vendor/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "packages/language-server/**/*.mjs",
      "packages/language-server/**/*.ts",
      "scripts/**/*.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-control-regex": "error",
    },
  },
);
