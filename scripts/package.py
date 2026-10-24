#!/usr/bin/env python3
"""Create a deterministic source archive without build outputs or user state."""

import argparse
import hashlib
import json
from pathlib import Path
import stat
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TOP_LEVEL = (
    "AGENTS.md", "Cargo.toml", "Cargo.lock", "LICENSE", "NOTICE", "README.md",
    "SECURITY.md", "CONTRIBUTING.md", "PULL_REQUEST.md", "SOURCE_MANIFEST.json",
    "package.json", "package-lock.json", "rust-toolchain.toml", ".editorconfig", ".gitignore",
)
SOURCE_DIRS = ("src", "worker", "tests", "scripts", "docs", "examples", ".github")
EXCLUDED_PARTS = {"node_modules", "target", ".git", "__pycache__", "test-results", "playwright-report", ".local"}
SOURCE_SUFFIXES = {".rs", ".mjs", ".json", ".py", ".md", ".yml", ".yaml", ".toml"}


def source_files():
    files = []
    for name in TOP_LEVEL:
        path = ROOT / name
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"Required source file is missing or not a regular file: {name}")
        files.append(path)
    for directory in SOURCE_DIRS:
        for path in (ROOT / directory).rglob("*"):
            relative = path.relative_to(ROOT)
            if any(part in EXCLUDED_PARTS for part in relative.parts):
                continue
            if path.is_symlink():
                raise SystemExit(f"Refusing to archive a symlink: {relative}")
            if path.is_file() and path.suffix in SOURCE_SUFFIXES:
                files.append(path)
    pending = ROOT / "Cargo.lock.pending"
    if pending.is_file(): files.append(pending)
    caddyfile = ROOT / "examples/Caddyfile"
    if caddyfile.is_file(): files.append(caddyfile)
    baseline = ROOT / "docs/baseline-stdio.Cargo.lock"
    if baseline.is_file(): files.append(baseline)
    return sorted(set(files), key=lambda path: path.relative_to(ROOT).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    output = args.output or ROOT / "dist" / f"sedna-browser-mcp-{version}-source.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    files = source_files()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            name = "browser-mcp/" + path.relative_to(ROOT).as_posix()
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            mode = 0o755 if path.parent.name == "scripts" else 0o644
            entry.external_attr = (stat.S_IFREG | mode) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, path.read_bytes())
    with zipfile.ZipFile(output) as archive:
        failure = archive.testzip()
        if failure:
            raise SystemExit(f"ZIP integrity failed: {failure}")
        if len(archive.namelist()) != len(files):
            raise SystemExit("ZIP source inventory mismatch")
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(json.dumps({"path": str(output.resolve()), "files": len(files), "bytes": output.stat().st_size, "sha256": digest}, indent=2))


if __name__ == "__main__":
    main()
