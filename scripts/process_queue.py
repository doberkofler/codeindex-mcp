#!/usr/bin/env python3
"""Process Markdown or JSON work queues in isolated OpenCode sessions."""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any


MARKDOWN_ITEM = re.compile(r"^- \[(?P<done>[ xX])\] #(?P<issue>[1-9][0-9]*) (?P<title>\S.*)$")
DEFAULT_MODEL = "deepseek/deepseek-flash"


class QueueError(Exception):
    """Raised when a queue or agent result violates the runner contract."""


@dataclass(frozen=True)
class QueueItem:
    issue: int
    description: str
    position: int


class Queue:
    def next_item(self) -> QueueItem | None:
        raise NotImplementedError

    def mark_done(self, item: QueueItem) -> None:
        raise NotImplementedError


def atomic_write(path: Path, content: str) -> None:
    mode = path.stat().st_mode
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            dir=path.parent,
            encoding="utf-8",
            newline="",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary_name = temporary.name
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


class MarkdownQueue(Queue):
    def __init__(self, path: Path) -> None:
        self.path = path
        with path.open(encoding="utf-8", newline="") as queue_file:
            self.lines = queue_file.readlines()
        self.items = self._parse_items()

    def _parse_items(self) -> list[tuple[QueueItem, bool]]:
        items: list[tuple[QueueItem, bool]] = []
        issues: set[int] = set()
        for position, line in enumerate(self.lines):
            candidate = line.rstrip("\r\n")
            if not candidate.startswith("- ["):
                continue
            match = MARKDOWN_ITEM.fullmatch(candidate)
            if match is None:
                raise QueueError(f"Malformed Markdown queue item on line {position + 1}")
            issue = int(match.group("issue"))
            if issue in issues:
                raise QueueError(f"Duplicate issue #{issue}")
            issues.add(issue)
            description = f"#{issue} {match.group('title')}"
            items.append(
                (
                    QueueItem(issue=issue, description=description, position=position),
                    match.group("done") != " ",
                )
            )
        return items

    def next_item(self) -> QueueItem | None:
        return next((item for item, done in self.items if not done), None)

    def mark_done(self, item: QueueItem) -> None:
        line = self.lines[item.position]
        if not line.startswith("- [ ] "):
            raise QueueError(f"Queue item #{item.issue} changed while it was running")
        self.lines[item.position] = f"- [x] {line.removeprefix('- [ ] ')}"
        atomic_write(self.path, "".join(self.lines))


class JsonQueue(Queue):
    def __init__(self, path: Path) -> None:
        self.path = path
        try:
            parsed: Any = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise QueueError(f"Invalid JSON queue: {error}") from error
        if not isinstance(parsed, dict) or not isinstance(parsed.get("items"), list):
            raise QueueError('JSON queue must be an object containing an "items" array')
        self.document: dict[str, Any] = parsed
        self.items = self._parse_items(parsed["items"])

    def _parse_items(self, values: list[Any]) -> list[tuple[QueueItem, bool]]:
        items: list[tuple[QueueItem, bool]] = []
        issues: set[int] = set()
        for position, value in enumerate(values):
            if not isinstance(value, dict):
                raise QueueError(f"JSON queue item {position + 1} must be an object")
            issue = value.get("issue")
            evaluation = value.get("evaluation")
            title = value.get("title")
            done = value.get("done")
            if isinstance(issue, bool) or not isinstance(issue, int) or issue <= 0:
                raise QueueError(f"JSON queue item {position + 1} has an invalid issue")
            if not isinstance(evaluation, str) or not evaluation.strip():
                raise QueueError(f"JSON queue item {position + 1} has an invalid evaluation")
            if not isinstance(title, str) or not title.strip():
                raise QueueError(f"JSON queue item {position + 1} has an invalid title")
            if not isinstance(done, bool):
                raise QueueError(f"JSON queue item {position + 1} has an invalid done value")
            if issue in issues:
                raise QueueError(f"Duplicate issue #{issue}")
            issues.add(issue)
            description = f"#{issue} [{evaluation}] {title}"
            items.append((QueueItem(issue, description, position), done))
        return items

    def next_item(self) -> QueueItem | None:
        return next((item for item, done in self.items if not done), None)

    def mark_done(self, item: QueueItem) -> None:
        values = self.document["items"]
        value = values[item.position]
        if not isinstance(value, dict) or value.get("done") is not False:
            raise QueueError(f"Queue item #{item.issue} changed while it was running")
        value["done"] = True
        atomic_write(self.path, f"{json.dumps(self.document, indent=2, ensure_ascii=False)}\n")


def load_queue(path: Path) -> Queue:
    if path.suffix.lower() == ".md":
        return MarkdownQueue(path)
    if path.suffix.lower() == ".json":
        return JsonQueue(path)
    raise QueueError("Queue must have a .md or .json extension")


def run_git(*arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def require_clean_tree(context: str) -> None:
    if run_git("status", "--porcelain"):
        raise QueueError(f"Dirty tree {context}")


def require_one_agent_commit(previous_head: str, queue_path: Path) -> None:
    head_with_parents = run_git("rev-list", "--parents", "-n", "1", "HEAD").split()
    if len(head_with_parents) != 2 or head_with_parents[1] != previous_head:
        raise QueueError("Agent must create exactly one non-merge commit")

    repository = Path(run_git("rev-parse", "--show-toplevel")).resolve()
    try:
        relative_queue = queue_path.resolve().relative_to(repository).as_posix()
    except ValueError as error:
        raise QueueError("Queue must be inside the Git repository") from error
    changed_paths = run_git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").splitlines()
    if not changed_paths:
        raise QueueError("Agent commit must contain changes")
    if relative_queue in changed_paths:
        raise QueueError("Agent commit must not modify the queue")


def prompt_for(item: QueueItem) -> str:
    return f"""Implement exactly this item, nothing else: {item.description}
Rules:
- Run tests/lint/typecheck; fix until green.
- Make one commit (conventional commit message).
- Do not touch other queue items."""


def agent_command(model: str, prompt: str) -> list[str]:
    command = [
        os.environ.get("OPENCODE_BIN", "opencode"),
        "run",
        "--standalone",
        "--auto",
        "--agent",
        "build",
    ]
    command.extend(["--model", model])
    command.append(prompt)
    return command


def process(queue_path: Path, model: str) -> None:
    while True:
        queue = load_queue(queue_path)
        item = queue.next_item()
        if item is None:
            return

        require_clean_tree(f"before: {item.description}")
        previous_head = run_git("rev-parse", "HEAD")
        subprocess.run(agent_command(model, prompt_for(item)), check=True)
        require_clean_tree(f"after: {item.description}")
        require_one_agent_commit(previous_head, queue_path)

        queue.mark_done(item)
        run_git("add", "--", str(queue_path))
        run_git("commit", "-m", f"chore: mark done: {item.description}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("queue", nargs="?", default="TODO.md", help="Markdown or JSON queue file")
    parser.add_argument(
        "--model",
        help=f"provider/model[#variant]; defaults to QUEUE_MODEL, then {DEFAULT_MODEL}",
    )
    arguments = parser.parse_args()
    model = arguments.model or os.environ.get("QUEUE_MODEL") or DEFAULT_MODEL
    try:
        process(Path(arguments.queue), model)
    except (OSError, QueueError, subprocess.CalledProcessError) as error:
        print(f"process-queue: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
