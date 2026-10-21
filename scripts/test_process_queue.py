import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.process_queue import JsonQueue, MarkdownQueue, QueueError, load_queue, prompt_for


class MarkdownQueueTest(unittest.TestCase):
    def test_marks_first_unchecked_item_without_changing_other_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "queue.md")
            path.write_text(
                "heading\n- [x] #1 completed\n- [ ] #2 [EVAL-002] title with `code` & /\n",
                encoding="utf-8",
            )

            queue = MarkdownQueue(path)
            item = queue.next_item()
            self.assertIsNotNone(item)
            assert item is not None
            self.assertEqual(item.description, "#2 [EVAL-002] title with `code` & /")
            queue.mark_done(item)

            self.assertEqual(
                path.read_text(encoding="utf-8"),
                "heading\n- [x] #1 completed\n- [x] #2 [EVAL-002] title with `code` & /\n",
            )

    def test_rejects_duplicate_issues(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "queue.md")
            path.write_text("- [ ] #1 first\n- [ ] #1 duplicate\n", encoding="utf-8")

            with self.assertRaisesRegex(QueueError, "Duplicate issue #1"):
                MarkdownQueue(path)


class JsonQueueTest(unittest.TestCase):
    def test_marks_item_done_and_preserves_extra_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "queue.json")
            path.write_text(
                '{"name":"milestone","items":[{"issue":14,"evaluation":"EVAL-006",'
                '"title":"Runner","done":false,"owner":"team"}]}',
                encoding="utf-8",
            )

            queue = JsonQueue(path)
            item = queue.next_item()
            self.assertIsNotNone(item)
            assert item is not None
            self.assertEqual(item.description, "#14 [EVAL-006] Runner")
            queue.mark_done(item)

            reloaded = JsonQueue(path)
            self.assertIsNone(reloaded.next_item())
            self.assertEqual(reloaded.document["name"], "milestone")
            self.assertEqual(reloaded.document["items"][0]["owner"], "team")

    def test_rejects_non_boolean_done(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "queue.json")
            path.write_text(
                '{"items":[{"issue":1,"evaluation":"EVAL-001","title":"Title","done":0}]}',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(QueueError, "invalid done"):
                JsonQueue(path)


class QueueTest(unittest.TestCase):
    def test_rejects_unknown_extension(self) -> None:
        with self.assertRaisesRegex(QueueError, r"\.md or \.json"):
            load_queue(Path("queue.jsonc"))

    def test_prompt_requires_verification_and_one_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "queue.md")
            path.write_text("- [ ] #14 [EVAL-006] Runner\n", encoding="utf-8")
            item = MarkdownQueue(path).next_item()
            self.assertIsNotNone(item)
            assert item is not None

            prompt = prompt_for(item)

            self.assertIn("Run tests/lint/typecheck", prompt)
            self.assertIn("Make one commit", prompt)


class ProcessQueueTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.repository = Path(self.temporary_directory.name)
        self.queue_path = self.repository / "queue.json"
        self.queue_path.write_text(
            '{"items":[{"issue":14,"evaluation":"EVAL-006",'
            '"title":"Runner","done":false}]}',
            encoding="utf-8",
        )
        self._git("init", "--quiet")
        self._git("config", "user.email", "test@example.com")
        self._git("config", "user.name", "Queue Test")

    def _git(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *arguments],
            cwd=self.repository,
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )

    def _write_agent(self, source: str) -> Path:
        agent = self.repository / "fake-opencode"
        agent.write_text(f"#!/usr/bin/env python3\n{source}", encoding="utf-8")
        agent.chmod(0o755)
        self._git("add", ".")
        self._git("commit", "--quiet", "-m", "test: initialize fixture")
        return agent

    def _run_queue(self, agent: Path) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["OPENCODE_BIN"] = str(agent)
        runner = Path(__file__).with_name("process_queue.py")
        return subprocess.run(
            [sys.executable, str(runner), str(self.queue_path)],
            cwd=self.repository,
            env=environment,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def test_runs_build_agent_and_commits_completion(self) -> None:
        agent = self._write_agent(
            """from pathlib import Path
import subprocess
import sys

expected = ["run", "--standalone", "--auto", "--agent", "build"]
if sys.argv[1:6] != expected:
    raise SystemExit(2)
Path("implementation.txt").write_text("implemented", encoding="utf-8")
subprocess.run(["git", "add", "implementation.txt"], check=True)
subprocess.run(
    ["git", "commit", "--quiet", "-m", "feat: implement item"],
    check=True,
)
"""
        )

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 0, result.stderr)
        queue = json.loads(self.queue_path.read_text(encoding="utf-8"))
        self.assertIs(queue["items"][0]["done"], True)
        self.assertEqual(self._git("rev-list", "--count", "HEAD").stdout.strip(), "3")

    def test_rejects_agent_that_does_not_commit(self) -> None:
        agent = self._write_agent("raise SystemExit(0)\n")

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 1)
        self.assertIn("Agent must create exactly one non-merge commit", result.stderr)
        queue = json.loads(self.queue_path.read_text(encoding="utf-8"))
        self.assertIs(queue["items"][0]["done"], False)


if __name__ == "__main__":
    unittest.main()
