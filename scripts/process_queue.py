#!/usr/bin/env python3
"""Process Markdown or JSON work queues in isolated OpenCode sessions.

Each agent run streams concise progress to stdout and writes its raw JSONL
event stream to $QUEUE_LOG_DIR, else $XDG_STATE_HOME/process-queue, else
~/.local/state/process-queue.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from dataclasses import dataclass
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, TextIO


MARKDOWN_ITEM = re.compile(r"^- \[(?P<done>[ xX])\] #(?P<issue>[1-9][0-9]*) (?P<title>\S.*)$")
DEFAULT_MODEL = "deepseek/deepseek-flash"
AGENT_NAME = "build"
MAX_PREVIEW_LINES = 20
MAX_PREVIEW_LINE_LENGTH = 400
TERMINAL_WIDTH_FALLBACK = 120
TERMINATE_TIMEOUT_SECONDS = 5.0
CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


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
        AGENT_NAME,
        "--format",
        "json",
    ]
    command.extend(["--model", model])
    command.append(prompt)
    return command


def log_directory() -> Path:
    configured = os.environ.get("QUEUE_LOG_DIR")
    if configured:
        return Path(configured).expanduser()
    state_home = os.environ.get("XDG_STATE_HOME")
    base = Path(state_home).expanduser() if state_home else Path.home() / ".local" / "state"
    return base / "process-queue"


def allocate_log_path(directory: Path, issue: int) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    candidate = directory / f"{stamp}-{issue}.jsonl"
    sequence = 1
    while candidate.exists():
        candidate = directory / f"{stamp}-{issue}-{sequence}.jsonl"
        sequence += 1
    return candidate


def display_path(path: Path) -> str:
    try:
        return f"~/{path.relative_to(Path.home()).as_posix()}"
    except ValueError:
        return str(path)


def terminal_width() -> int:
    columns = shutil.get_terminal_size((TERMINAL_WIDTH_FALLBACK, 24)).columns
    return max(60, min(160, columns))


def sanitize(value: str) -> str:
    return CONTROL_CHARACTERS.sub("", value)


def clip(value: str, width: int) -> str:
    if len(value) <= width:
        return value
    return f"{value[: width - 1]}…"


def shorten(value: str, width: int | None = None) -> str:
    text = " ".join(sanitize(value).split())
    return clip(text, width or terminal_width())


def tool_detail(name: str, values: dict[str, Any]) -> str:
    if name == "execute":
        code = values.get("code")
        if isinstance(code, str):
            return next((line.strip() for line in code.splitlines() if line.strip()), "")

    keys = {
        "bash": ("command",),
        "read": ("filePath", "path"),
        "write": ("filePath", "path"),
        "edit": ("filePath", "path"),
        "glob": ("pattern",),
        "grep": ("pattern",),
        "list": ("path",),
        "webfetch": ("url",),
        "task": ("description",),
        "skill": ("name",),
    }.get(name, ())
    for key in keys:
        value = values.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def summarize_tool(part: Any) -> str:
    if not isinstance(part, dict):
        return "tool"
    name = part.get("tool")
    if not isinstance(name, str) or not name:
        name = "tool"
    state = part.get("state")
    detail = ""
    if isinstance(state, dict):
        values = state.get("input")
        if isinstance(values, dict):
            detail = tool_detail(name, values)
        if not detail:
            title = state.get("title")
            if isinstance(title, str) and title != name:
                detail = title
    return shorten(f"{name} {detail}".strip())


def format_duration(seconds: float) -> str:
    whole = int(seconds)
    if whole < 60:
        return f"{seconds:.1f}s"
    return f"{whole // 60}m{whole % 60:02d}s"


class RunReporter:
    def __init__(
        self,
        model: str,
        verbose: bool,
        stream: TextIO,
    ) -> None:
        self.model = model
        self.verbose = verbose
        self.stream = stream
        self.started = time.monotonic()
        self.tool_calls = 0
        self.seen_tools: set[str] = set()
        self.tokens = 0
        self.cost = 0.0

    def _timestamp(self) -> str:
        elapsed = int(time.monotonic() - self.started)
        return f"[{elapsed // 60:02d}:{elapsed % 60:02d}]"

    def _write(self, text: str) -> None:
        print(text, file=self.stream, flush=True)

    def start(self, item: QueueItem) -> None:
        self._write(f"[queue] {item.description}")
        self._write(f"[agent] {AGENT_NAME} · {self.model}")

    def _message(self, label: str, text: str) -> None:
        lines = sanitize(text).strip("\n").splitlines()
        if not lines:
            return
        prefix = f"{self._timestamp()} {label} › "
        visible = lines[:MAX_PREVIEW_LINES]
        for index, line in enumerate(visible):
            preview = clip(line, MAX_PREVIEW_LINE_LENGTH)
            self._write(prefix + preview if index == 0 else " " * len(prefix) + preview)
        if len(lines) > len(visible):
            remaining = len(lines) - len(visible)
            self._write(" " * len(prefix) + f"… {remaining} more lines (see log)")

    def _tool(self, part: Any) -> None:
        if not isinstance(part, dict):
            return
        state = part.get("state")
        status = state.get("status") if isinstance(state, dict) else None
        identifier = part.get("id")
        finished = status in {"completed", "error"}
        if finished:
            if isinstance(identifier, str):
                if identifier in self.seen_tools:
                    return
                self.seen_tools.add(identifier)
            self.tool_calls += 1

        symbol = {"completed": "✓", "error": "✗", "running": "…"}.get(str(status), "•")
        message = f"{symbol} {summarize_tool(part)}"
        if status == "error" and isinstance(state, dict):
            error = state.get("error")
            if isinstance(error, str) and error.strip():
                message += f": {shorten(error, 200)}"
        self._write(f"{self._timestamp()} {message}")

    def _step_finish(self, part: Any) -> None:
        if not isinstance(part, dict):
            return
        tokens = part.get("tokens")
        if isinstance(tokens, dict):
            for key in ("input", "output", "reasoning"):
                value = tokens.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    self.tokens += value
        cost = part.get("cost")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            self.cost += float(cost)

    def _error(self, event: dict[str, Any]) -> None:
        error = event.get("error")
        message = ""
        if isinstance(error, dict):
            data = error.get("data")
            if isinstance(data, dict) and isinstance(data.get("message"), str):
                message = data["message"]
            if not message and isinstance(error.get("message"), str):
                message = error["message"]
            if not message and isinstance(error.get("name"), str):
                message = error["name"]
        elif isinstance(error, str):
            message = error
        self._message("error", message or "OpenCode reported an error")

    def consume(self, line: str) -> None:
        stripped = line.strip()
        if not stripped:
            return
        try:
            event: Any = json.loads(stripped)
        except json.JSONDecodeError:
            if self.verbose:
                self._write(f"{self._timestamp()} log: {shorten(stripped)}")
            return
        if not isinstance(event, dict):
            return

        kind = event.get("type")
        part = event.get("part")
        if kind == "text" and isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                self._message("agent", text)
        elif kind == "tool_use":
            self._tool(part)
        elif kind == "step_finish":
            self._step_finish(part)
        elif kind == "error":
            self._error(event)
        elif self.verbose:
            self._write(f"{self._timestamp()} event: {shorten(str(kind))}")

    def interrupted(self) -> None:
        self._write("[queue] interrupted; terminating OpenCode")

    def finish(self, returncode: int, log_path: Path) -> None:
        elapsed = time.monotonic() - self.started
        status = "finished" if returncode == 0 else f"failed (exit {returncode})"
        details = [format_duration(elapsed)]
        if self.tool_calls:
            suffix = "" if self.tool_calls == 1 else "s"
            details.append(f"{self.tool_calls} tool{suffix}")
        if self.tokens:
            details.append(f"{self.tokens:,} tokens")
        if self.cost:
            details.append(f"${self.cost:.4f}")
        self._write(f"[agent] {status} in " + " · ".join(details))
        self._write(f"[log] {display_path(log_path)}")


def terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=TERMINATE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run_agent(item: QueueItem, model: str, verbose: bool) -> None:
    log_path = allocate_log_path(log_directory(), item.issue)
    reporter = RunReporter(model, verbose, sys.stdout)
    reporter.start(item)

    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            agent_command(model, prompt_for(item)),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        try:
            assert process.stdout is not None
            for line in process.stdout:
                log.write(line)
                log.flush()
                reporter.consume(line)
            returncode = process.wait()
        except KeyboardInterrupt:
            reporter.interrupted()
            terminate(process)
            raise
        except Exception:
            terminate(process)
            raise

    reporter.finish(returncode, log_path)
    if returncode != 0:
        raise QueueError(
            f"OpenCode exited with status {returncode}; log: {display_path(log_path)}"
        )


def process(queue_path: Path, model: str, verbose: bool) -> None:
    while True:
        queue = load_queue(queue_path)
        item = queue.next_item()
        if item is None:
            return

        require_clean_tree(f"before: {item.description}")
        previous_head = run_git("rev-parse", "HEAD")
        run_agent(item, model, verbose)
        require_clean_tree(f"after: {item.description}")
        require_one_agent_commit(previous_head, queue_path)

        queue.mark_done(item)
        run_git("add", "--", str(queue_path))
        run_git("commit", "-m", f"chore: mark done: {item.description}")
        print(f"[queue] #{item.issue} done", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("queue", nargs="?", default="TODO.md", help="Markdown or JSON queue file")
    parser.add_argument(
        "--model",
        help=f"provider/model[#variant]; defaults to QUEUE_MODEL, then {DEFAULT_MODEL}",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="show agent diagnostics and unrecognized events",
    )
    arguments = parser.parse_args()
    model = arguments.model or os.environ.get("QUEUE_MODEL") or DEFAULT_MODEL
    try:
        process(Path(arguments.queue), model, arguments.verbose)
    except KeyboardInterrupt:
        print("process-queue: interrupted", file=sys.stderr)
        return 130
    except (OSError, QueueError, subprocess.CalledProcessError) as error:
        print(f"process-queue: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
