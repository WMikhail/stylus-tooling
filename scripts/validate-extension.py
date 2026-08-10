#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 and earlier
    tomllib = None


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_ROOT = ROOT / "editors" / "zed"
MANIFEST_PATH = EXTENSION_ROOT / "extension.toml"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
GIT_REVISION = re.compile(r"^[0-9a-f]{40}$")
GITHUB_REPOSITORY = re.compile(
    r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$"
)
FORBIDDEN_NAME_WORD = re.compile(r"(?:^|[^a-z])(zed|extension)(?:$|[^a-z])")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate the Stylus Zed extension")
    parser.add_argument(
        "--release",
        action="store_true",
        help="enforce public GitHub repositories and release-only constraints",
    )
    return parser.parse_args()


def strip_toml_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    for index, character in enumerate(line):
        if escaped:
            escaped = False
            continue
        if quote == '"' and character == "\\":
            escaped = True
            continue
        if quote is not None:
            if character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character == "#":
            return line[:index]
    return line


def toml_structure(value: str) -> tuple[list[str], str | None]:
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    pairs = {"]": "[", "}": "{"}
    for character in value:
        if escaped:
            escaped = False
            continue
        if quote == '"' and character == "\\":
            escaped = True
            continue
        if quote is not None:
            if character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character in "[{":
            stack.append(character)
        elif character in "]}":
            if not stack or stack.pop() != pairs[character]:
                raise ValueError("unbalanced delimiter")
    return stack, quote


def split_toml_items(value: str, delimiter: str) -> list[str]:
    items: list[str] = []
    start = 0
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    pairs = {"]": "[", "}": "{"}
    for index, character in enumerate(value):
        if escaped:
            escaped = False
            continue
        if quote == '"' and character == "\\":
            escaped = True
            continue
        if quote is not None:
            if character == quote:
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character in "[{":
            stack.append(character)
        elif character in "]}":
            if not stack or stack.pop() != pairs[character]:
                raise ValueError("unbalanced delimiter")
        elif character == delimiter and not stack:
            items.append(value[start:index].strip())
            start = index + 1
    items.append(value[start:].strip())
    return items


def split_toml_assignment(value: str) -> tuple[str, str]:
    parts = split_toml_items(value, "=")
    if len(parts) != 2:
        raise ValueError("expected one key = value assignment")
    return parts[0], parts[1]


def parse_toml_key(value: str) -> str:
    value = value.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return value
    parsed = parse_toml_value(value)
    if not isinstance(parsed, str) or not parsed:
        raise ValueError("invalid key")
    return parsed


def parse_toml_value(value: str) -> object:
    value = value.strip()
    if not value:
        raise ValueError("missing value")
    if value in {"true", "false"}:
        return value == "true"
    if re.fullmatch(r"[+-]?\d(?:_?\d)*", value):
        return int(value.replace("_", ""))
    if re.fullmatch(r"[+-]?(?:\d(?:_?\d)*)?\.\d(?:_?\d)*", value):
        return float(value.replace("_", ""))
    if value[0] in {'"', "'"}:
        try:
            parsed = ast.literal_eval(value)
        except (SyntaxError, ValueError) as error:
            raise ValueError("invalid string") from error
        if not isinstance(parsed, str):
            raise ValueError("invalid string")
        return parsed
    if value.startswith("["):
        if not value.endswith("]"):
            raise ValueError("unterminated array")
        inner = value[1:-1].strip()
        if not inner:
            return []
        items = split_toml_items(inner, ",")
        if items[-1] == "":
            items.pop()
        if not items or any(not item for item in items):
            raise ValueError("invalid array")
        return [parse_toml_value(item) for item in items]
    if value.startswith("{"):
        if not value.endswith("}"):
            raise ValueError("unterminated inline table")
        inner = value[1:-1].strip()
        if not inner:
            return {}
        items = split_toml_items(inner, ",")
        if items[-1] == "":
            raise ValueError("inline tables cannot have a trailing comma")
        result: dict[str, object] = {}
        for item in items:
            key_source, item_value = split_toml_assignment(item)
            key = parse_toml_key(key_source)
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = parse_toml_value(item_value)
        return result
    raise ValueError(f"unsupported TOML value: {value}")


def load_toml_fallback(path: Path) -> dict:
    try:
        source_lines = path.read_text().splitlines()
    except OSError as error:
        raise ValueError(f"cannot read {path.relative_to(ROOT)}: {error}") from error

    logical_lines: list[tuple[int, str]] = []
    buffer: list[str] = []
    start_line = 0
    for line_number, source_line in enumerate(source_lines, start=1):
        line = strip_toml_comment(source_line).strip()
        if not line:
            continue
        if not buffer:
            start_line = line_number
        buffer.append(line)
        statement = " ".join(buffer)
        try:
            stack, quote = toml_structure(statement)
        except ValueError as error:
            raise ValueError(
                f"cannot read {path.relative_to(ROOT)}:{start_line}: {error}"
            ) from error
        if quote is not None:
            raise ValueError(
                f"cannot read {path.relative_to(ROOT)}:{start_line}: unterminated string"
            )
        if not stack:
            logical_lines.append((start_line, statement))
            buffer = []
    if buffer:
        raise ValueError(
            f"cannot read {path.relative_to(ROOT)}:{start_line}: unterminated value"
        )

    result: dict[str, object] = {}
    current = result
    for line_number, statement in logical_lines:
        try:
            if statement.startswith("["):
                if not statement.endswith("]") or statement.startswith("[["):
                    raise ValueError("invalid table header")
                section = statement[1:-1].strip()
                if not section:
                    raise ValueError("empty table")
                current = result
                for part in section.split("."):
                    key = parse_toml_key(part)
                    existing = current.setdefault(key, {})
                    if not isinstance(existing, dict):
                        raise ValueError(f"table conflicts with value: {key}")
                    current = existing
                continue
            key_source, value_source = split_toml_assignment(statement)
            key = parse_toml_key(key_source)
            if key in current:
                raise ValueError(f"duplicate key: {key}")
            current[key] = parse_toml_value(value_source)
        except ValueError as error:
            raise ValueError(
                f"cannot read {path.relative_to(ROOT)}:{line_number}: {error}"
            ) from error
    return result


def load_toml(path: Path) -> dict:
    if tomllib is None:
        return load_toml_fallback(path)
    try:
        with path.open("rb") as file:
            return tomllib.load(file)
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ValueError(f"cannot read {path.relative_to(ROOT)}: {error}") from error


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "--", str(EXTENSION_ROOT.relative_to(ROOT))],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        excluded = {".git", "grammars", "node_modules", "vendor"}
        return [
            path.relative_to(EXTENSION_ROOT)
            for path in EXTENSION_ROOT.rglob("*")
            if path.is_file()
            and not excluded.intersection(path.relative_to(EXTENSION_ROOT).parts)
        ]
    prefix = EXTENSION_ROOT.relative_to(ROOT)
    return [
        Path(item.decode()).relative_to(prefix)
        for item in result.stdout.split(b"\0")
        if item
    ]


def local_repository_path(url: str) -> Path | None:
    parsed = urlparse(url)
    if parsed.scheme != "file":
        return None
    return Path(unquote(parsed.path))


def validate_repository(
    value: object,
    field: str,
    errors: list[str],
    release: bool,
) -> Path | None:
    if not isinstance(value, str) or not value:
        errors.append(f"{field} must be a non-empty URL")
        return None

    if release:
        if not GITHUB_REPOSITORY.fullmatch(value):
            errors.append(f"{field} must be a public HTTPS GitHub repository")
        if re.search(r"owner|your[-_ ]?(?:name|username)", value, re.IGNORECASE):
            errors.append(f"{field} still contains a placeholder")
        return None

    local_path = local_repository_path(value)
    if local_path is not None and not local_path.is_dir():
        errors.append(f"{field} points to a missing local directory: {local_path}")
    elif local_path is None and not GITHUB_REPOSITORY.fullmatch(value):
        errors.append(f"{field} must be a file:// URL or an HTTPS GitHub repository")
    return local_path


def validate_snippet_catalog(
    catalog: object,
    path: Path,
    errors: list[str],
) -> None:
    label = path.as_posix()
    if not isinstance(catalog, dict) or not catalog:
        errors.append(f"{label} must contain a non-empty JSON object")
        return

    for name, snippet in catalog.items():
        prefix = f"{label}: snippet {name!r}"
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{label} contains an empty snippet name")
            continue
        if not isinstance(snippet, dict):
            errors.append(f"{prefix} must be an object")
            continue

        snippet_prefix = snippet.get("prefix")
        valid_prefix = isinstance(snippet_prefix, str) and bool(snippet_prefix.strip())
        if isinstance(snippet_prefix, list):
            valid_prefix = bool(snippet_prefix) and all(
                isinstance(item, str) and item.strip() for item in snippet_prefix
            )
        if not valid_prefix:
            errors.append(f"{prefix} needs a non-empty prefix")

        body = snippet.get("body")
        valid_body = isinstance(body, str) and bool(body)
        if isinstance(body, list):
            valid_body = bool(body) and all(isinstance(line, str) for line in body)
        if not valid_body:
            errors.append(f"{prefix} needs a string or non-empty string array body")

        description = snippet.get("description")
        if description is not None and (
            not isinstance(description, str) or not description.strip()
        ):
            errors.append(f"{prefix} description must be a non-empty string")


def validate_snippets(value: object, errors: list[str]) -> None:
    if value is None:
        return
    if not isinstance(value, list) or not value:
        errors.append("snippets must be a non-empty array of JSON paths")
        return

    root = EXTENSION_ROOT.resolve()
    for entry in value:
        if not isinstance(entry, str) or not entry.strip():
            errors.append("every snippets entry must be a relative JSON path")
            continue
        relative_path = Path(entry)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            errors.append(f"snippet path must stay inside the extension: {entry}")
            continue
        snippet_path = (EXTENSION_ROOT / relative_path).resolve()
        try:
            snippet_path.relative_to(root)
        except ValueError:
            errors.append(f"snippet path must stay inside the extension: {entry}")
            continue
        if snippet_path.suffix.lower() != ".json" or not snippet_path.is_file():
            errors.append(f"snippet file is missing or not JSON: {entry}")
            continue
        try:
            catalog = json.loads(snippet_path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"cannot read snippet file {entry}: {error}")
            continue
        validate_snippet_catalog(catalog, relative_path, errors)


def main() -> int:
    args = parse_args()
    errors: list[str] = []

    try:
        manifest = load_toml(MANIFEST_PATH)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    required_strings = ("id", "name", "version", "description", "repository")
    for field in required_strings:
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            errors.append(f"{field} must be a non-empty string")

    extension_id = manifest.get("id", "")
    extension_name = manifest.get("name", "")
    if isinstance(extension_id, str) and FORBIDDEN_NAME_WORD.search(extension_id.lower()):
        errors.append("id must not contain the words 'zed' or 'extension'")
    if isinstance(extension_name, str) and FORBIDDEN_NAME_WORD.search(extension_name.lower()):
        errors.append("name must not contain the words 'zed' or 'extension'")
    if isinstance(manifest.get("version"), str) and not SEMVER.fullmatch(manifest["version"]):
        errors.append("version must use MAJOR.MINOR.PATCH semantic versioning")
    if manifest.get("schema_version") != 1:
        errors.append("schema_version must be 1")

    authors = manifest.get("authors")
    if not isinstance(authors, list) or not authors or not all(
        isinstance(author, str) and author.strip() for author in authors
    ):
        errors.append("authors must be a non-empty array of names")

    validate_repository(
        manifest.get("repository"), "repository", errors, args.release
    )
    validate_snippets(manifest.get("snippets"), errors)

    languages = manifest.get("languages")
    if not isinstance(languages, list) or not languages:
        errors.append("languages must declare at least one language directory")
    else:
        for language in languages:
            if not isinstance(language, str):
                errors.append("every languages entry must be a relative path")
                continue
            language_path = EXTENSION_ROOT / language
            config_path = language_path / "config.toml"
            if not language_path.is_dir() or not config_path.is_file():
                errors.append(f"language directory is incomplete: {language}")
                continue
            try:
                config = load_toml(config_path)
            except ValueError as error:
                errors.append(str(error))
                continue
            for field in ("name", "grammar"):
                if not isinstance(config.get(field), str) or not config[field]:
                    errors.append(f"{config_path.relative_to(ROOT)} needs {field}")

    grammars = manifest.get("grammars")
    if not isinstance(grammars, dict) or not grammars:
        errors.append("grammars must declare at least one Tree-sitter grammar")
    else:
        for grammar_name, grammar in grammars.items():
            if not isinstance(grammar, dict):
                errors.append(f"grammars.{grammar_name} must be a table")
                continue
            grammar_path = validate_repository(
                grammar.get("repository"),
                f"grammars.{grammar_name}.repository",
                errors,
                args.release,
            )
            revision = grammar.get("rev")
            if not isinstance(revision, str) or not GIT_REVISION.fullmatch(revision):
                errors.append(f"grammars.{grammar_name}.rev must be a full Git commit SHA")
            elif grammar_path is not None:
                result = subprocess.run(
                    ["git", "-C", str(grammar_path), "cat-file", "-e", f"{revision}^{{commit}}"],
                    check=False,
                    capture_output=True,
                )
                if result.returncode != 0:
                    errors.append(
                        f"grammars.{grammar_name}.rev does not exist in {grammar_path}"
                    )

    license_files = [
        path for path in EXTENSION_ROOT.iterdir() if path.is_file() and path.name.lower().startswith(("license", "licence"))
    ]
    if not license_files:
        errors.append("an accepted license file is required at the extension root")
    elif not any("MIT License" in path.read_text(errors="replace") for path in license_files):
        errors.append("the root license file is not recognized as MIT")

    files = tracked_files()
    if args.release and not files:
        errors.append("release repository has no tracked extension files")
    forbidden_roots = {"build", "grammars", "node_modules", "vendor"}
    for path in files:
        if path.parts and path.parts[0] in forbidden_roots:
            errors.append(f"release repository must not track local artifact: {path}")
        if "changelog" in path.name.lower():
            errors.append(f"release repository must not contain a changelog: {path}")

    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    mode = "release" if args.release else "development"
    print(f"extension.toml passed {mode} validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
