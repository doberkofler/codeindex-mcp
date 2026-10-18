#!/usr/bin/env python3
"""Count physical source lines per language under a directory.

The measurement counts physical lines, so blank and comment lines are included.
It reports files and lines per language plus a total.

Only regular files inside the root are measured. Vendored dependencies, build
output, caches, and version-control metadata are excluded by directory name.

Usage:
	python3 countSourceLines.py
	python3 countSourceLines.py --root /path/to/workspace
	python3 countSourceLines.py --json
"""

import argparse
import json
import os
from pathlib import Path

EXCLUDED_DIRECTORY_NAMES = frozenset({
	'.git',
	'.hg',
	'.svn',
	'.cache',
	'.mypy_cache',
	'.pytest_cache',
	'.venv',
	'venv',
	'__pycache__',
	'node_modules',
	'vendor',
	'vendors',
	'third_party',
	'third-party',
	'3rdparty',
	'generated',
	'dist',
	'build',
	'coverage',
	'target',
	'out',
	'cmakefiles',
})

LANGUAGE_EXTENSIONS: dict[str, frozenset[str]] = {
	'C': frozenset({'.c', '.h'}),
	'C++': frozenset({'.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'}),
	'C#': frozenset({'.cs'}),
	'Go': frozenset({'.go'}),
	'Java': frozenset({'.java'}),
	'JavaScript': frozenset({'.js', '.jsx', '.mjs', '.cjs'}),
	'Kotlin': frozenset({'.kt', '.kts'}),
	'Python': frozenset({'.py'}),
	'Rust': frozenset({'.rs'}),
	'Shell': frozenset({'.sh', '.bash', '.zsh'}),
	'SQL': frozenset({'.sql', '.pls', '.pks', '.pkb', '.prc', '.fnc', '.trg'}),
	'TypeScript': frozenset({'.ts', '.tsx', '.mts', '.cts'}),
}


def physical_line_count(path: Path) -> int:
	"""Count newlines, counting a final line that has no trailing newline."""
	data = path.read_bytes()
	if not data:
		return 0
	return data.count(b'\n') + (0 if data.endswith(b'\n') else 1)


def language_for(path: Path) -> str | None:
	"""Return the language owning a path, or None when it is not measured."""
	suffix = path.suffix.lower()
	for language, extensions in LANGUAGE_EXTENSIONS.items():
		if suffix in extensions:
			return language
	return None


def iter_source_paths(root: Path) -> list[Path]:
	"""Return regular files under root, excluding known non-source directories."""
	paths: list[Path] = []
	for directory, child_directories, file_names in os.walk(root, followlinks=False):
		child_directories[:] = [
			name for name in child_directories
			if name.lower() not in EXCLUDED_DIRECTORY_NAMES
			and not (Path(directory) / name).is_symlink()
		]
		for file_name in file_names:
			path = Path(directory) / file_name
			if path.is_symlink() or not path.is_file():
				continue
			if language_for(path) is None:
				continue
			paths.append(path)
	return paths


def measure(root: Path) -> dict[str, dict[str, int]]:
	"""Return per-language file and line counts for the workspace."""
	counts: dict[str, dict[str, int]] = {
		language: {'files': 0, 'lines': 0}
		for language in LANGUAGE_EXTENSIONS
	}
	for path in iter_source_paths(root):
		language = language_for(path)
		if language is None:
			continue
		counts[language]['files'] += 1
		counts[language]['lines'] += physical_line_count(path)
	return counts


def format_markdown(counts: dict[str, dict[str, int]]) -> str:
	"""Render the measurement as a Markdown table."""
	lines = [
		'| Language | Files | Lines |',
		'| --- | ---: | ---: |',
	]
	for language, result in counts.items():
		lines.append(f"| {language} | {result['files']:,} | {result['lines']:,} |")
	total_files = sum(result['files'] for result in counts.values())
	total_lines = sum(result['lines'] for result in counts.values())
	lines.append(f'| **Total** | **{total_files:,}** | **{total_lines:,}** |')
	return '\n'.join(lines)


def parse_arguments() -> argparse.Namespace:
	parser = argparse.ArgumentParser(
		description='Count physical source lines per language.',
	)
	parser.add_argument(
		'--root',
		type=Path,
		default=Path.cwd(),
		help='workspace root (default: the current directory)',
	)
	parser.add_argument(
		'--json',
		action='store_true',
		help='print JSON instead of a Markdown table',
	)
	return parser.parse_args()


def main() -> None:
	arguments = parse_arguments()
	root = arguments.root.resolve()
	if not root.is_dir():
		raise SystemExit(f'Not a directory: {root}')
	counts = measure(root)
	if arguments.json:
		print(json.dumps(counts, indent=2))
		return
	print(format_markdown(counts))


if __name__ == '__main__':
	main()
