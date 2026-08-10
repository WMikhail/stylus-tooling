#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
GRAMMAR_DIR = ROOT / "vendor" / "tree-sitter-stylus"
TREE_SITTER = GRAMMAR_DIR / "node_modules" / ".bin" / "tree-sitter"
MIN_PARSE_RATE = int(os.environ.get("STYLUS_MIN_PARSE_RATE", "1000"))
RATE = re.compile(r"average speed:\s+(\d+)\s+bytes/ms")


def benchmark_source() -> str:
    blocks: list[str] = ["$primary = #4f46e5\n"]
    for index in range(1200):
        blocks.append(
            f".component-{index}\n"
            "  color $primary\n"
            "  padding 8px 16px\n"
            "  &:hover\n"
            "    color darken($primary, 10%)\n"
        )
    return "\n".join(blocks)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="stylus-performance-") as temp_dir:
        temp = Path(temp_dir)
        fixture = temp / "benchmark.styl"
        fixture.write_text(benchmark_source())
        config = temp / "config.json"
        config.write_text(json.dumps({"parser-directories": [str(ROOT / "vendor")]}))

        rates: list[int] = []
        for _ in range(3):
            result = subprocess.run(
                [
                    str(TREE_SITTER),
                    "parse",
                    "--config-path",
                    str(config),
                    "--quiet",
                    "--stat",
                    str(fixture),
                ],
                cwd=GRAMMAR_DIR,
                check=False,
                capture_output=True,
                text=True,
            )
            output = result.stdout + result.stderr
            if result.returncode != 0:
                print(output.strip(), file=sys.stderr)
                return result.returncode
            match = RATE.search(output)
            if match is None:
                print("error: Tree-sitter did not report a parse rate", file=sys.stderr)
                return 1
            rates.append(int(match.group(1)))

    median_rate = int(statistics.median(rates))
    if median_rate < MIN_PARSE_RATE:
        print(
            f"error: median parse rate {median_rate} bytes/ms is below "
            f"the {MIN_PARSE_RATE} bytes/ms budget",
            file=sys.stderr,
        )
        return 1
    print(
        f"Performance budget passed: {median_rate} bytes/ms "
        f"(minimum {MIN_PARSE_RATE} bytes/ms)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
