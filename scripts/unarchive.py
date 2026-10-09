#!/usr/bin/env python3
"""Compatibility entry point for native, authenticated DSH thread recovery."""
from pathlib import Path
import subprocess
import sys


def main() -> int:
    entry = Path(__file__).resolve().with_suffix('.mjs')
    try:
        return subprocess.run(['node', str(entry), *sys.argv[1:]], check=False).returncode
    except FileNotFoundError:
        print('Node is required for authenticated thread recovery.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
