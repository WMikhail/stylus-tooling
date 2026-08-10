#!/usr/bin/env python3

"""Validate capture-level golden assertions for every Zed query.

Tree-sitter CLI 0.25 can associate multiple assertions with a capture from a
previous row and does not reliably enforce negative assertions. This runner
uses the CLI's capture stream but matches every expectation by exact range.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
GRAMMAR_DIR = ROOT / "vendor" / "tree-sitter-stylus"
TREE_SITTER = GRAMMAR_DIR / "node_modules" / ".bin" / "tree-sitter"
QUERY_DIR = ROOT / "editors" / "zed" / "languages" / "stylus"
FIXTURE_DIR = ROOT / "tests" / "queries"

ASSERTION = re.compile(
    r"//(?P<prefix>.*?)(?P<arrow><-|(?P<carets>\^+))\s*"
    r"(?P<negative>!)?(?P<name>[A-Za-z0-9_.-]+)\s*$"
)
CAPTURE = re.compile(
    r"capture:\s+(?:\d+\s+-\s+)?(?P<name>[A-Za-z0-9_.-]+),\s+"
    r"start:\s+\((?P<start_row>\d+),\s*(?P<start_column>\d+)\),\s+"
    r"end:\s+\((?P<end_row>\d+),\s*(?P<end_column>\d+)\)"
)


@dataclass(frozen=True)
class Assertion:
    row: int
    column: int
    length: int
    name: str
    negative: bool


@dataclass(frozen=True)
class Capture:
    name: str
    start: tuple[int, int]
    end: tuple[int, int]

    def contains(self, row: int, column: int) -> bool:
        return self.start <= (row, column) < self.end


def parse_assertions(path: Path) -> list[Assertion]:
    lines = path.read_text().splitlines()
    assertions: list[Assertion] = []
    source_row: int | None = None

    for row, line in enumerate(lines):
        match = ASSERTION.search(line)
        if match is None:
            if line.strip():
                source_row = row
            continue
        if source_row is None:
            raise ValueError(f"{path}: assertion at line {row + 1} has no source line")

        if match.group("arrow") == "<-":
            column = line.index("//")
            length = 1
        else:
            column = match.start("carets")
            length = len(match.group("carets"))
        assertions.append(
            Assertion(
                row=source_row,
                column=column,
                length=length,
                name=match.group("name"),
                negative=match.group("negative") is not None,
            )
        )

    if not assertions:
        raise ValueError(f"{path}: no query assertions found")
    return assertions


def query_captures(query: Path, fixture: Path, config: Path) -> list[Capture]:
    result = subprocess.run(
        [
            str(TREE_SITTER),
            "query",
            "--captures",
            "--config-path",
            str(config),
            str(query),
            str(fixture),
        ],
        cwd=GRAMMAR_DIR,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"{query.name}: query failed for {fixture.name}:\n{details}")

    captures: list[Capture] = []
    for line in result.stdout.splitlines():
        match = CAPTURE.search(line)
        if match is None:
            continue
        captures.append(
            Capture(
                name=match.group("name"),
                start=(int(match.group("start_row")), int(match.group("start_column"))),
                end=(int(match.group("end_row")), int(match.group("end_column"))),
            )
        )
    return captures


def validate_assertions(
    fixture: Path,
    assertions: list[Assertion],
    captures: list[Capture],
) -> list[str]:
    failures: list[str] = []
    for assertion in assertions:
        positions = [
            (assertion.row, assertion.column + offset)
            for offset in range(assertion.length)
        ]
        matched = all(
            any(capture.name == assertion.name and capture.contains(*position) for capture in captures)
            for position in positions
        )
        if assertion.negative == matched:
            expectation = "not capture" if assertion.negative else "capture"
            failures.append(
                f"{fixture}:{assertion.row + 1}:{assertion.column + 1}: "
                f"expected {expectation} {assertion.name}"
            )
    return failures


def main() -> int:
    if not TREE_SITTER.is_file():
        print(
            "error: missing Tree-sitter CLI; run npm ci in vendor/tree-sitter-stylus",
            file=sys.stderr,
        )
        return 1

    queries = sorted(QUERY_DIR.glob("*.scm"))
    fixture_names = {path.stem for path in FIXTURE_DIR.glob("*.styl")}
    query_names = {path.stem for path in queries}
    if fixture_names != query_names:
        missing = sorted(query_names - fixture_names)
        extra = sorted(fixture_names - query_names)
        if missing:
            print(f"error: missing query fixtures: {', '.join(missing)}", file=sys.stderr)
        if extra:
            print(f"error: fixtures without queries: {', '.join(extra)}", file=sys.stderr)
        return 1

    failures: list[str] = []
    assertion_count = 0
    with tempfile.TemporaryDirectory(prefix="stylus-query-tests-") as temp_dir:
        config = Path(temp_dir) / "config.json"
        config.write_text(json.dumps({"parser-directories": [str(ROOT / "vendor")]}))
        for query in queries:
            fixture = FIXTURE_DIR / f"{query.stem}.styl"
            try:
                assertions = parse_assertions(fixture)
                captures = query_captures(query, fixture, config)
            except (OSError, RuntimeError, ValueError) as error:
                failures.append(str(error))
                continue
            assertion_count += len(assertions)
            failures.extend(
                validate_assertions(fixture, assertions, captures)
            )

    if failures:
        for failure in failures:
            print(f"error: {failure}", file=sys.stderr)
        return 1

    print(f"Validated {assertion_count} captures across {len(queries)} query files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
