#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_ROOT = ROOT / "editors" / "zed"
VALIDATOR_PATH = ROOT / "scripts" / "validate-extension.py"
SPEC = importlib.util.spec_from_file_location("validate_extension", VALIDATOR_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {VALIDATOR_PATH}")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class TomlFallbackTests(unittest.TestCase):
    def test_current_manifest_and_language_config(self) -> None:
        manifest = VALIDATOR.load_toml_fallback(EXTENSION_ROOT / "extension.toml")
        config = VALIDATOR.load_toml_fallback(
            EXTENSION_ROOT / "languages/stylus/config.toml"
        )

        self.assertRegex(manifest["grammars"]["stylus"]["rev"], r"^[0-9a-f]{40}$")
        self.assertEqual(manifest["snippets"], ["./snippets/stylus.json"])
        self.assertEqual(manifest["lib"]["kind"], "Rust")
        self.assertEqual(
            manifest["language_servers"]["stylus-language-server"]["languages"],
            ["Stylus", "Vue.js", "Svelte", "Astro"],
        )
        self.assertTrue((EXTENSION_ROOT / "Cargo.toml").is_file())
        self.assertTrue((EXTENSION_ROOT / "src/stylus.rs").is_file())
        self.assertTrue((ROOT / "packages/language-server/src/server.ts").is_file())
        self.assertEqual(config["name"], "Stylus")
        self.assertEqual(len(config["brackets"]), 6)
        self.assertEqual(config["brackets"][0]["start"], "[")
        self.assertFalse(config["brackets"][0]["newline"])

    def test_rejects_malformed_values(self) -> None:
        malformed_values = (
            '"unterminated',
            "[1,",
            "[1,,2]",
            "{ key = 1, }",
        )
        for value in malformed_values:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    VALIDATOR.parse_toml_value(value)

    def test_rejects_malformed_snippet_catalogs(self) -> None:
        errors: list[str] = []
        VALIDATOR.validate_snippet_catalog(
            {
                "Missing body": {"prefix": "missing"},
                "Bad prefix": {"prefix": [], "body": ["color red"]},
            },
            Path("snippets/broken.json"),
            errors,
        )

        self.assertEqual(len(errors), 2)
        self.assertTrue(any("needs a string" in error for error in errors))
        self.assertTrue(any("needs a non-empty prefix" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
