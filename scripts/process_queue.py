#!/usr/bin/env python3
"""Process Markdown TODO or explicit GitHub-issue queues in isolated sessions.

Interactive runs show transient progress. Every item emits a persistent summary
and writes raw agent JSONL plus complete history to $QUEUE_LOG_DIR, else
$XDG_STATE_HOME/process-queue, else ~/.local/state/process-queue.

GitHub queues use {"version": 1, "kind": "github-issues", "items": [{"url":
"https://github.com/OWNER/REPOSITORY/issues/NUMBER"}]}. Completion commits close
issues after reaching the default branch. macOS runs prevent idle system sleep.
"""

from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime
import json
import os
from dataclasses import dataclass
from pathlib import Path
import queue as queue_module
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, TextIO


MARKDOWN_ITEM = re.compile(r"^- \[(?P<done>[ xX])\] #(?P<issue>[1-9][0-9]*) (?P<title>\S.*)$")
GITHUB_ISSUE_URL = re.compile(
    r"https://github\.com/(?P<owner>[A-Za-z0-9_.-]+)/(?P<repository>[A-Za-z0-9_.-]+)/issues/(?P<issue>[1-9][0-9]*)/?"
)
DEFAULT_MODEL = "deepseek/deepseek-flash"
AGENT_NAME = "build"
MAX_PREVIEW_LINES = 20
MAX_PREVIEW_LINE_LENGTH = 400
TERMINAL_WIDTH_FALLBACK = 120
TERMINATE_TIMEOUT_SECONDS = 5.0
DEFAULT_AGENT_TIMEOUT_SECONDS = 3600.0
DEFAULT_VERIFY_TIMEOUT_SECONDS = 900.0
FAILURE_TAIL_LINES = 20
CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
ANSI_ESCAPE_SEQUENCE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


class QueueError(Exception):
    """Raised when a queue or agent result violates the runner contract."""


class TerminationRequested(Exception):
    """Raised when the runner receives SIGTERM."""


@dataclass(frozen=True)
class QueueItem:
    issue: int
    description: str
    position: int
    source_url: str | None = None
    details: str | None = None


@dataclass(frozen=True)
class RunLogs:
    agent: Path
    history: Path


class Queue:
    def next_item(self) -> QueueItem | None:
        raise NotImplementedError

    def mark_done(self, item: QueueItem) -> None:
        raise NotImplementedError

    def commit_done(self, item: QueueItem) -> None:
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

    def commit_done(self, item: QueueItem) -> None:
        self.mark_done(item)
        run_git("add", "--", str(self.path))
        run_git("commit", "-m", f"chore: mark done: {item.description}")


class JsonQueue(Queue):
    def __init__(self, path: Path, parsed: Any | None = None) -> None:
        self.path = path
        if parsed is None:
            parsed = parse_json_queue(path)
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

    def commit_done(self, item: QueueItem) -> None:
        self.mark_done(item)
        run_git("add", "--", str(self.path))
        run_git("commit", "-m", f"chore: mark done: {item.description}")


class GithubQueue(Queue):
    def __init__(self, path: Path | None, parsed: Any) -> None:
        self.path = path
        if not isinstance(parsed, dict):
            raise QueueError("GitHub queue must be a JSON object")
        version = parsed.get("version")
        if isinstance(version, bool) or version != 1:
            raise QueueError("GitHub queue version must be 1")
        if parsed.get("kind") != "github-issues":
            raise QueueError('GitHub queue kind must be "github-issues"')
        values = parsed.get("items")
        if not isinstance(values, list):
            raise QueueError('GitHub queue must contain an "items" array')
        self.items = self._parse_items(values)

    def _parse_items(self, values: list[Any]) -> list[QueueItem]:
        items: list[QueueItem] = []
        urls: set[str] = set()
        for position, value in enumerate(values):
            if not isinstance(value, dict) or set(value) != {"url"}:
                raise QueueError(
                    f'GitHub queue item {position + 1} must contain only a "url" field'
                )
            url = value.get("url")
            if not isinstance(url, str):
                raise QueueError(f"GitHub queue item {position + 1} has an invalid URL")
            match = GITHUB_ISSUE_URL.fullmatch(url)
            if match is None:
                raise QueueError(f"GitHub queue item {position + 1} has an invalid issue URL")
            canonical_url = url.removesuffix("/")
            if canonical_url in urls:
                raise QueueError(f"Duplicate GitHub issue URL: {canonical_url}")
            urls.add(canonical_url)
            issue = int(match.group("issue"))
            items.append(
                QueueItem(
                    issue=issue,
                    description=f"#{issue}",
                    position=position,
                    source_url=canonical_url,
                )
            )
        return items

    def next_item(self) -> QueueItem | None:
        for item in self.items:
            if item.source_url is None or has_completion_commit(item.source_url):
                continue
            issue = read_github_issue(item.source_url)
            if issue["state"] == "CLOSED":
                continue
            return QueueItem(
                issue=item.issue,
                description=f"#{item.issue} {issue['title']}",
                position=item.position,
                source_url=item.source_url,
                details=issue["body"],
            )
        return None

    def mark_done(self, item: QueueItem) -> None:
        if item.source_url is None:
            raise QueueError(f"GitHub queue item #{item.issue} has no source URL")

    def commit_done(self, item: QueueItem) -> None:
        self.mark_done(item)
        source_url = item.source_url
        if source_url is None:
            raise QueueError(f"GitHub queue item #{item.issue} has no source URL")
        closure_reference = github_closure_reference(source_url)
        run_git(
            "commit",
            "--allow-empty",
            "-m",
            f"chore: mark done: {item.description}",
            "-m",
            f"Closes {closure_reference}",
        )


def parse_json_queue(path: Path) -> Any:
    return parse_json_content(path.read_text(encoding="utf-8"))


def parse_json_content(content: str) -> Any:
    try:
        return json.loads(content)
    except json.JSONDecodeError as error:
        raise QueueError(f"Invalid JSON queue: {error}") from error


def load_queue(path: Path | None, content: str | None = None) -> Queue:
    if path is None:
        if content is None:
            raise QueueError("Missing stdin queue content")
        parsed = parse_json_content(content)
        if isinstance(parsed, dict) and parsed.get("kind") == "github-issues":
            return GithubQueue(None, parsed)
        raise QueueError('stdin requires a JSON queue with kind "github-issues"')
    if path.suffix.lower() == ".md":
        return MarkdownQueue(path)
    if path.suffix.lower() == ".json":
        parsed = parse_json_queue(path)
        if isinstance(parsed, dict) and parsed.get("kind") == "github-issues":
            return GithubQueue(path, parsed)
        if isinstance(parsed, dict) and "kind" in parsed:
            raise QueueError(f"Unsupported JSON queue kind: {parsed.get('kind')!r}")
        return JsonQueue(path, parsed)
    raise QueueError("Queue must have a .md or .json extension")


def run_git(*arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def has_completion_commit(issue_url: str) -> bool:
    closure_reference = github_closure_reference(issue_url)
    return bool(
        run_git(
            "log",
            "-n",
            "1",
            "--format=%H",
            "--extended-regexp",
            f"--grep=^Closes {re.escape(closure_reference)}$",
        )
    )


def github_closure_reference(issue_url: str) -> str:
    match = GITHUB_ISSUE_URL.fullmatch(issue_url)
    if match is None:
        raise QueueError(f"Invalid GitHub issue URL: {issue_url}")
    return f"{match.group('owner')}/{match.group('repository')}#{match.group('issue')}"


def read_github_issue(issue_url: str) -> dict[str, str]:
    result = subprocess.run(
        [
            os.environ.get("GH_BIN", "gh"),
            "issue",
            "view",
            issue_url,
            "--json",
            "number,state,title,body,url",
        ],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        value: Any = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise QueueError(f"GitHub returned invalid JSON for {issue_url}") from error
    if not isinstance(value, dict):
        raise QueueError(f"GitHub returned an invalid issue for {issue_url}")
    expected = GITHUB_ISSUE_URL.fullmatch(issue_url)
    number = value.get("number")
    state = value.get("state")
    title = value.get("title")
    body = value.get("body")
    url = value.get("url")
    if (
        expected is None
        or isinstance(number, bool)
        or not isinstance(number, int)
        or number != int(expected.group("issue"))
        or state not in {"OPEN", "CLOSED"}
        or not isinstance(title, str)
        or not title.strip()
        or not isinstance(body, str)
        or not isinstance(url, str)
        or url.removesuffix("/") != issue_url
    ):
        raise QueueError(f"GitHub returned an invalid issue for {issue_url}")
    return {"state": state, "title": title.strip(), "body": body}


def require_clean_tree(context: str) -> None:
    if run_git("status", "--porcelain"):
        raise QueueError(f"Dirty tree {context}")


def repository_root() -> Path:
    return Path(run_git("rev-parse", "--show-toplevel"))


def require_one_agent_commit(previous_head: str, queue_path: Path | None) -> None:
    head_with_parents = run_git("rev-list", "--parents", "-n", "1", "HEAD").split()
    if len(head_with_parents) != 2 or head_with_parents[1] != previous_head:
        raise QueueError("Agent must create exactly one non-merge commit")

    changed_paths = run_git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").splitlines()
    if not changed_paths:
        raise QueueError("Agent commit must contain changes")
    if queue_path is None:
        return

    repository = repository_root().resolve()
    try:
        relative_queue = queue_path.resolve().relative_to(repository).as_posix()
    except ValueError as error:
        raise QueueError("Queue must be inside the Git repository") from error
    if relative_queue in changed_paths:
        raise QueueError("Agent commit must not modify the queue")


def prompt_for(item: QueueItem, queue_path: Path | None) -> str:
    source = ""
    completion_rule = ""
    queue_rule = "- Queue source is read-only stdin.\n"
    if queue_path is not None:
        queue_rule = f"- Do not modify the queue file: {queue_path.resolve()}\n"
    if item.source_url is not None:
        source = f"\nGitHub issue: {item.source_url}\n\nIssue body:\n{item.details or ''}\n"
        completion_rule = (
            "- Do not close the GitHub issue; the queue runner records completion "
            "after verification.\n"
        )
    return f"""Implement exactly this item, nothing else: {item.description}{source}
Rules:
- Run tests/lint/typecheck; fix until green.
- Make one commit (conventional commit message).
{queue_rule}\
{completion_rule}\
- The queue runner marks the current item done after validating your commit."""


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


def allocate_log_paths(directory: Path, issue: int | str) -> RunLogs:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    stem = f"{stamp}-{issue}"
    agent = directory / f"{stem}.jsonl"
    history = directory / f"{stem}.log"
    sequence = 1
    while agent.exists() or history.exists():
        stem = f"{stamp}-{issue}-{sequence}"
        agent = directory / f"{stem}.jsonl"
        history = directory / f"{stem}.log"
        sequence += 1
    return RunLogs(agent=agent, history=history)


def open_private(path: Path) -> TextIO:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(descriptor, "w", encoding="utf-8")


def display_path(path: Path) -> str:
    try:
        return f"~/{path.relative_to(Path.home()).as_posix()}"
    except ValueError:
        return str(path)


def terminal_width() -> int:
    columns = shutil.get_terminal_size((TERMINAL_WIDTH_FALLBACK, 24)).columns
    return max(60, min(160, columns))


def sanitize(value: str) -> str:
    return CONTROL_CHARACTERS.sub("", ANSI_ESCAPE_SEQUENCE.sub("", value))


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


class LiveDisplay:
    """Transient TTY-only phase and rolling preview display."""

    def __init__(self, stream: TextIO) -> None:
        self.stream = stream
        self.enabled = stream.isatty()
        self.phase = "starting"
        self.started = time.monotonic()
        self.preview: deque[str] = deque(maxlen=8)
        self.rendered_lines = 0
        self.frame = 0

    def set_phase(self, phase: str) -> None:
        self.phase = phase
        self.render()

    def add(self, text: str) -> None:
        for line in sanitize(text).splitlines():
            if line.strip():
                self.preview.append(shorten(line))
        self.render()

    def render(self) -> None:
        if not self.enabled:
            return
        self._clear()
        frames = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
        elapsed = format_duration(time.monotonic() - self.started)
        lines = [f"{frames[self.frame % len(frames)]} {self.phase} · {elapsed}"]
        self.frame += 1
        lines.extend(f"  {line}" for line in self.preview)
        for line in lines:
            print(f"\033[2K{clip(line, terminal_width())}", file=self.stream)
        self.stream.flush()
        self.rendered_lines = len(lines)

    def clear(self) -> None:
        if self.enabled:
            self._clear()
            self.stream.flush()

    def _clear(self) -> None:
        if self.rendered_lines == 0:
            return
        print(f"\033[{self.rendered_lines}A", end="", file=self.stream)
        for _ in range(self.rendered_lines):
            print("\033[2K", file=self.stream)
        print(f"\033[{self.rendered_lines}A", end="", file=self.stream)
        self.rendered_lines = 0


class RunReporter:
    def __init__(
        self,
        model: str,
        verbose: bool,
        stream: TextIO,
        live: LiveDisplay | None = None,
    ) -> None:
        self.model = model
        self.verbose = verbose
        self.stream = stream
        self.live = live or LiveDisplay(stream)
        self.started = time.monotonic()
        self.tool_calls = 0
        self.seen_tools: set[str] = set()
        self.tokens = 0
        self.cost = 0.0
        self.final_text = ""

    def _timestamp(self) -> str:
        elapsed = int(time.monotonic() - self.started)
        return f"[{elapsed // 60:02d}:{elapsed % 60:02d}]"

    def _write(self, text: str) -> None:
        print(text, file=self.stream, flush=True)

    def start(self, item: QueueItem) -> None:
        self._write(f"[queue] {item.description}")
        self._write(f"[agent] {AGENT_NAME} · {self.model}")
        self.live.set_phase("agent")

    def _message(self, label: str, text: str) -> None:
        lines = sanitize(text).strip("\n").splitlines()
        if not lines:
            return
        if label == "agent":
            self.final_text = sanitize(text).strip()
        if self.live.enabled:
            self.live.add(f"{label} › {lines[-1]}")
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
        if self.live.enabled:
            self.live.add(message)
        else:
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
                message = f"log: {shorten(stripped)}"
                if self.live.enabled:
                    self.live.add(message)
                else:
                    self._write(f"{self._timestamp()} {message}")
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
            message = f"event: {shorten(str(kind))}"
            if self.live.enabled:
                self.live.add(message)
            else:
                self._write(f"{self._timestamp()} {message}")

    def interrupted(self) -> None:
        self.live.clear()
        self._write("[queue] interrupted; terminating OpenCode")

    def finish(self, returncode: int, logs: RunLogs) -> None:
        self.live.clear()
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
        if self.final_text:
            lines = self.final_text.splitlines()
            for index, line in enumerate(lines[:MAX_PREVIEW_LINES]):
                prefix = "[summary] " if index == 0 else "          "
                self._write(f"{prefix}{clip(line, MAX_PREVIEW_LINE_LENGTH)}")
            if len(lines) > MAX_PREVIEW_LINES:
                self._write(f"          … {len(lines) - MAX_PREVIEW_LINES} more lines (see log)")
        self._write(f"[log] {display_path(logs.history)}")
        self._write(f"[agent-log] {display_path(logs.agent)}")


def terminate(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    deadline = time.monotonic() + TERMINATE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except (PermissionError, ProcessLookupError):
            break
        time.sleep(0.05)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (PermissionError, ProcessLookupError):
            pass

    if process.poll() is None:
        process.wait()


def read_process_stream(
    source: str,
    stream: TextIO,
    events: queue_module.Queue[tuple[str, str | None]],
) -> None:
    try:
        for line in stream:
            events.put((source, line))
    finally:
        events.put((source, None))


def print_failure_tail(lines: deque[str]) -> None:
    if not lines:
        return
    print(f"[failure] last {len(lines)} log lines:", file=sys.stderr)
    for line in lines:
        print(f"  {clip(line, MAX_PREVIEW_LINE_LENGTH)}", file=sys.stderr)


def start_stream_threads(
    process: subprocess.Popen[str],
) -> tuple[queue_module.Queue[tuple[str, str | None]], list[threading.Thread]]:
    if process.stdout is None or process.stderr is None:
        terminate(process)
        raise QueueError("Child process streams are unavailable")
    events: queue_module.Queue[tuple[str, str | None]] = queue_module.Queue()
    threads = [
        threading.Thread(
            target=read_process_stream,
            args=("stdout", process.stdout, events),
            daemon=True,
        ),
        threading.Thread(
            target=read_process_stream,
            args=("stderr", process.stderr, events),
            daemon=True,
        ),
    ]
    for thread in threads:
        thread.start()
    return events, threads


def run_agent(
    item: QueueItem,
    queue_path: Path | None,
    model: str,
    verbose: bool,
    timeout: float,
) -> RunLogs:
    logs = allocate_log_paths(log_directory(), item.issue)
    live = LiveDisplay(sys.stdout)
    reporter = RunReporter(model, verbose, sys.stdout, live)
    reporter.start(item)
    tail: deque[str] = deque(maxlen=FAILURE_TAIL_LINES)
    timed_out = False

    with open_private(logs.agent) as agent_log, open_private(logs.history) as history_log:
        process = subprocess.Popen(
            agent_command(model, prompt_for(item, queue_path)),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            start_new_session=True,
        )
        events, threads = start_stream_threads(process)
        deadline = time.monotonic() + timeout
        open_streams = len(threads)
        try:
            while open_streams:
                if not timed_out and time.monotonic() >= deadline:
                    timed_out = True
                    terminate(process)
                try:
                    source, line = events.get(timeout=0.1)
                except queue_module.Empty:
                    live.render()
                    continue
                if line is None:
                    open_streams -= 1
                    continue
                clean_line = sanitize(line.rstrip("\r\n"))
                if clean_line:
                    tail.append(f"{source}: {clean_line}")
                history_log.write(f"[{source}] {line}")
                history_log.flush()
                if source == "stdout":
                    agent_log.write(line)
                    agent_log.flush()
                    reporter.consume(line)
                elif verbose:
                    reporter.consume(line)
            returncode = process.wait()
        except KeyboardInterrupt:
            reporter.interrupted()
            terminate(process)
            raise
        except Exception:
            live.clear()
            terminate(process)
            raise
        finally:
            for thread in threads:
                thread.join(timeout=TERMINATE_TIMEOUT_SECONDS)

    reporter.finish(returncode, logs)
    if timed_out:
        print_failure_tail(tail)
        raise QueueError(
            f"OpenCode timed out after {format_duration(timeout)}; log: "
            f"{display_path(logs.history)}"
        )
    if returncode != 0:
        print_failure_tail(tail)
        raise QueueError(
            f"OpenCode exited with status {returncode}; log: {display_path(logs.history)}"
        )
    return logs


def run_verification(command: str, timeout: float, logs: RunLogs, phase: str) -> None:
    live = LiveDisplay(sys.stdout)
    live.set_phase(phase)
    print(f"[verify] {phase} · {command}", flush=True)
    started = time.monotonic()
    tail: deque[str] = deque(maxlen=FAILURE_TAIL_LINES)
    timed_out = False

    if not logs.history.exists():
        with open_private(logs.history):
            pass
    with logs.history.open("a", encoding="utf-8") as history_log:
        process = subprocess.Popen(
            ["/bin/sh", "-c", command],
            cwd=repository_root(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            start_new_session=True,
        )
        events, threads = start_stream_threads(process)
        deadline = time.monotonic() + timeout
        open_streams = len(threads)
        try:
            while open_streams:
                if not timed_out and time.monotonic() >= deadline:
                    timed_out = True
                    terminate(process)
                try:
                    source, line = events.get(timeout=0.1)
                except queue_module.Empty:
                    live.render()
                    continue
                if line is None:
                    open_streams -= 1
                    continue
                clean_line = sanitize(line.rstrip("\r\n"))
                if clean_line:
                    tail.append(f"{source}: {clean_line}")
                    live.add(clean_line)
                history_log.write(f"[verify:{source}] {line}")
                history_log.flush()
            returncode = process.wait()
        except KeyboardInterrupt:
            terminate(process)
            raise
        except Exception:
            terminate(process)
            raise
        finally:
            live.clear()
            for thread in threads:
                thread.join(timeout=TERMINATE_TIMEOUT_SECONDS)

    elapsed = format_duration(time.monotonic() - started)
    if timed_out:
        print(f"[verify] {phase} timed out after {format_duration(timeout)}", flush=True)
        print_failure_tail(tail)
        raise QueueError(f"Verification timed out; log: {display_path(logs.history)}")
    if returncode != 0:
        print(f"[verify] {phase} failed (exit {returncode}) in {elapsed}", flush=True)
        print_failure_tail(tail)
        raise QueueError(
            f"Verification exited with status {returncode}; log: {display_path(logs.history)}"
        )
    print(f"[verify] {phase} passed in {elapsed}", flush=True)


def process(
    queue_path: Path | None,
    queue_content: str | None,
    model: str,
    verbose: bool,
    verify_command: str | None,
    agent_timeout: float,
    verify_timeout: float,
) -> None:
    run_started = time.monotonic()
    completed = 0
    total_item_time = 0.0

    load_queue(queue_path, queue_content)
    require_clean_tree("before verification preflight")
    if verify_command is None:
        print("[verify] skipped by explicit --no-verify", flush=True)
    else:
        preflight_logs = allocate_log_paths(log_directory(), "preflight")
        run_verification(verify_command, verify_timeout, preflight_logs, "preflight")
        require_clean_tree("after verification preflight")

    while True:
        queue = load_queue(queue_path, queue_content)
        item = queue.next_item()
        if item is None:
            elapsed = time.monotonic() - run_started
            details = [f"{completed} completed", f"{format_duration(elapsed)} total"]
            if completed:
                details.append(f"{format_duration(total_item_time / completed)} average")
            print(f"[run] {' · '.join(details)}", flush=True)
            return

        item_started = time.monotonic()
        require_clean_tree(f"before: {item.description}")
        previous_head = run_git("rev-parse", "HEAD")
        logs = run_agent(item, queue_path, model, verbose, agent_timeout)
        require_clean_tree(f"after: {item.description}")
        require_one_agent_commit(previous_head, queue_path)
        if verify_command is not None:
            run_verification(verify_command, verify_timeout, logs, "post-commit")
            require_clean_tree(f"after verification: {item.description}")

        queue.commit_done(item)
        duration = time.monotonic() - item_started
        completed += 1
        total_item_time += duration
        commit = run_git("rev-parse", "--short", "HEAD~1")
        print(
            f"[result] #{item.issue} done · commit {commit} · {format_duration(duration)}",
            flush=True,
        )


def positive_seconds(value: str) -> float:
    try:
        seconds = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number of seconds") from error
    if seconds <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return seconds


def handle_sigterm(_signum: int, _frame: object) -> None:
    raise TerminationRequested


def start_sleep_inhibitor() -> subprocess.Popen[bytes] | None:
    if sys.platform != "darwin":
        return None
    executable = shutil.which("caffeinate")
    if executable is None:
        raise QueueError("macOS caffeinate executable is unavailable")
    return subprocess.Popen(
        [executable, "-i", "-w", str(os.getpid())],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def stop_sleep_inhibitor(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=TERMINATE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "queue",
        nargs="?",
        default="TODO.md",
        help='Markdown or JSON queue file; use "-" for a GitHub JSON queue on stdin',
    )
    parser.add_argument(
        "--model",
        help=f"provider/model[#variant]; defaults to QUEUE_MODEL, then {DEFAULT_MODEL}",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="show agent diagnostics and unrecognized events",
    )
    verification = parser.add_mutually_exclusive_group(required=True)
    verification.add_argument(
        "--verify",
        metavar="COMMAND",
        help="trusted shell command run before agents and after each agent commit",
    )
    verification.add_argument(
        "--no-verify",
        action="store_true",
        help="explicitly skip independent verification",
    )
    parser.add_argument(
        "--timeout",
        type=positive_seconds,
        default=DEFAULT_AGENT_TIMEOUT_SECONDS,
        metavar="SECONDS",
        help=f"agent wall-clock timeout (default: {DEFAULT_AGENT_TIMEOUT_SECONDS:g})",
    )
    parser.add_argument(
        "--verify-timeout",
        type=positive_seconds,
        default=DEFAULT_VERIFY_TIMEOUT_SECONDS,
        metavar="SECONDS",
        help=f"verification wall-clock timeout (default: {DEFAULT_VERIFY_TIMEOUT_SECONDS:g})",
    )
    arguments = parser.parse_args()
    if arguments.verify is not None and not arguments.verify.strip():
        parser.error("--verify command must not be empty")
    model = arguments.model or os.environ.get("QUEUE_MODEL") or DEFAULT_MODEL
    queue_path = None if arguments.queue == "-" else Path(arguments.queue)
    queue_content = sys.stdin.read() if queue_path is None else None
    previous_sigterm = signal.signal(signal.SIGTERM, handle_sigterm)
    sleep_inhibitor: subprocess.Popen[bytes] | None = None
    try:
        sleep_inhibitor = start_sleep_inhibitor()
        process(
            queue_path,
            queue_content,
            model,
            arguments.verbose,
            arguments.verify,
            arguments.timeout,
            arguments.verify_timeout,
        )
    except KeyboardInterrupt:
        print("process-queue: interrupted", file=sys.stderr)
        return 130
    except TerminationRequested:
        print("process-queue: terminated", file=sys.stderr)
        return 143
    except (OSError, QueueError, subprocess.CalledProcessError) as error:
        print(f"process-queue: {error}", file=sys.stderr)
        return 1
    finally:
        stop_sleep_inhibitor(sleep_inhibitor)
        signal.signal(signal.SIGTERM, previous_sigterm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
