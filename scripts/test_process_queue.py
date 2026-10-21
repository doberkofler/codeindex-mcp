import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from scripts.process_queue import (
    DEFAULT_MODEL,
    JsonQueue,
    MarkdownQueue,
    QueueError,
    RunReporter,
    load_queue,
    prompt_for,
)


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

            prompt = prompt_for(item, path)

            self.assertIn("Run tests/lint/typecheck", prompt)
            self.assertIn("Make one commit", prompt)
            self.assertIn(f"Do not modify the queue file: {path.resolve()}", prompt)


class ProcessQueueTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.log_temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.log_temporary_directory.cleanup)
        self.repository = Path(self.temporary_directory.name)
        self.log_directory = Path(self.log_temporary_directory.name)
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

    def _run_queue(self, agent: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["OPENCODE_BIN"] = str(agent)
        environment["QUEUE_LOG_DIR"] = str(self.log_directory)
        environment.pop("QUEUE_MODEL", None)
        runner = Path(__file__).with_name("process_queue.py")
        return subprocess.run(
            [sys.executable, str(runner), *arguments, str(self.queue_path)],
            cwd=self.repository,
            env=environment,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def _agent_argv(self) -> list[str]:
        return json.loads((self.repository / "argv.json").read_text(encoding="utf-8"))

    def _write_recording_agent(self) -> Path:
        return self._write_agent(
            """import json
from pathlib import Path
import subprocess
import sys

Path("argv.json").write_text(json.dumps(sys.argv[1:]), encoding="utf-8")
Path("implementation.txt").write_text("implemented", encoding="utf-8")
subprocess.run(["git", "add", "argv.json", "implementation.txt"], check=True)
subprocess.run(
    ["git", "commit", "--quiet", "-m", "feat: implement item"],
    check=True,
)
"""
        )

    def test_runs_build_agent_and_commits_completion(self) -> None:
        agent = self._write_recording_agent()

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self._agent_argv()
        self.assertEqual(
            argv[:7],
            ["run", "--standalone", "--auto", "--agent", "build", "--format", "json"],
        )
        self.assertEqual(argv[7:9], ["--model", DEFAULT_MODEL])
        self.assertTrue(argv[-1].startswith("Implement exactly this item"))
        self.assertIn(
            f"Do not modify the queue file: {self.queue_path.resolve()}", argv[-1]
        )
        queue = json.loads(self.queue_path.read_text(encoding="utf-8"))
        self.assertIs(queue["items"][0]["done"], True)
        self.assertEqual(self._git("rev-list", "--count", "HEAD").stdout.strip(), "3")

    def test_passes_explicit_model(self) -> None:
        agent = self._write_recording_agent()

        result = self._run_queue(agent, "--model", "openai/gpt-5.6-sol")

        self.assertEqual(result.returncode, 0, result.stderr)
        argv = self._agent_argv()
        self.assertEqual(argv[7:9], ["--model", "openai/gpt-5.6-sol"])

    def test_reads_model_from_environment(self) -> None:
        agent = self._write_recording_agent()
        environment = os.environ.copy()
        environment["OPENCODE_BIN"] = str(agent)
        environment["QUEUE_LOG_DIR"] = str(self.log_directory)
        environment["QUEUE_MODEL"] = "ollama/qwen3.8:27b-mlx"
        runner = Path(__file__).with_name("process_queue.py")

        result = subprocess.run(
            [sys.executable, str(runner), str(self.queue_path)],
            cwd=self.repository,
            env=environment,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self._agent_argv()[7:9], ["--model", "ollama/qwen3.8:27b-mlx"]
        )

    def test_rejects_agent_that_does_not_commit(self) -> None:
        agent = self._write_agent("raise SystemExit(0)\n")

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 1)
        self.assertIn("Agent must create exactly one non-merge commit", result.stderr)
        queue = json.loads(self.queue_path.read_text(encoding="utf-8"))
        self.assertIs(queue["items"][0]["done"], False)

    def _write_event_agent(self, exit_code: int = 0) -> Path:
        return self._write_agent(
            f"""import json
from pathlib import Path
import subprocess

events = [
    {{
        "type": "tool_use",
        "part": {{
            "id": "call_1",
            "tool": "read",
            "state": {{
                "status": "completed",
                "input": {{"path": "README.md"}},
                "title": "read",
            }},
        }},
    }},
    {{
        "type": "step_finish",
        "part": {{
            "cost": 0.0012,
            "tokens": {{"input": 100, "output": 20, "reasoning": 0}},
        }},
    }},
    {{"type": "text", "part": {{"text": "Implemented\\nthe runner."}}}},
]
for event in events:
    print(json.dumps(event), flush=True)
Path("implementation.txt").write_text("implemented", encoding="utf-8")
subprocess.run(["git", "add", "implementation.txt"], check=True)
subprocess.run(
    ["git", "commit", "--quiet", "-m", "feat: implement item"],
    check=True,
)
raise SystemExit({exit_code})
"""
        )

    def test_renders_progress_and_writes_raw_log(self) -> None:
        agent = self._write_event_agent()

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("[agent] build · deepseek/deepseek-flash", result.stdout)
        self.assertIn("✓ read README.md", result.stdout)
        self.assertIn("agent › Implemented", result.stdout)
        self.assertIn("the runner.", result.stdout)
        self.assertIn("1 tool", result.stdout)
        self.assertIn("120 tokens", result.stdout)
        self.assertIn("$0.0012", result.stdout)
        self.assertIn("[agent] finished", result.stdout)
        self.assertIn("[queue] #14 done", result.stdout)
        self.assertNotIn('"type"', result.stdout)
        self.assertNotIn('"type"', result.stderr)

        logs = sorted(self.log_directory.glob("*.jsonl"))
        self.assertEqual(len(logs), 1)
        self.assertIn('"type": "tool_use"', logs[0].read_text(encoding="utf-8"))

    def test_reports_agent_failure_with_log_path(self) -> None:
        agent = self._write_event_agent(exit_code=7)

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 1)
        self.assertIn("[agent] failed (exit 7)", result.stdout)
        self.assertIn("OpenCode exited with status 7", result.stderr)
        logs = sorted(self.log_directory.glob("*.jsonl"))
        self.assertEqual(len(logs), 1)
        self.assertIn(logs[0].name, result.stdout)

    def test_hides_unstructured_output_by_default(self) -> None:
        agent = self._write_agent(
            """import subprocess

print("unstructured diagnostic", flush=True)
with open("implementation.txt", "w", encoding="utf-8") as stream:
    stream.write("implemented")
subprocess.run(["git", "add", "implementation.txt"], check=True)
subprocess.run(
    ["git", "commit", "--quiet", "-m", "feat: implement item"],
    check=True,
)
"""
        )

        result = self._run_queue(agent)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("unstructured diagnostic", result.stdout)

    def test_interrupt_terminates_agent_without_traceback(self) -> None:
        agent = self._write_agent(
            """import os
from pathlib import Path
import time

Path("agent.pid").write_text(str(os.getpid()), encoding="utf-8")
time.sleep(60)
"""
        )
        environment = os.environ.copy()
        environment["OPENCODE_BIN"] = str(agent)
        environment["QUEUE_LOG_DIR"] = str(self.log_directory)
        environment.pop("QUEUE_MODEL", None)
        runner = Path(__file__).with_name("process_queue.py")

        process = subprocess.Popen(
            [sys.executable, str(runner), str(self.queue_path)],
            cwd=self.repository,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        def kill_runner() -> None:
            if process.poll() is None:
                process.kill()
                process.wait()

        self.addCleanup(kill_runner)
        pid_path = self.repository / "agent.pid"
        deadline = time.monotonic() + 10
        while not pid_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(pid_path.exists())
        agent_pid = int(pid_path.read_text(encoding="utf-8"))

        process.send_signal(signal.SIGINT)
        stdout, stderr = process.communicate(timeout=15)

        self.assertEqual(process.returncode, 130, stderr)
        self.assertIn("interrupted; terminating OpenCode", stdout)
        self.assertIn("process-queue: interrupted", stderr)
        self.assertNotIn("Traceback", stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(agent_pid, 0)


class RunReporterTest(unittest.TestCase):
    def test_verbose_shows_unstructured_output(self) -> None:
        output = io.StringIO()
        reporter = RunReporter("deepseek/deepseek-flash", True, output)

        reporter.consume("unstructured diagnostic")

        self.assertIn("unstructured diagnostic", output.getvalue())

    def test_default_hides_unstructured_output(self) -> None:
        output = io.StringIO()
        reporter = RunReporter("deepseek/deepseek-flash", False, output)

        reporter.consume("unstructured diagnostic")

        self.assertEqual(output.getvalue(), "")

    def test_strips_terminal_control_sequences(self) -> None:
        output = io.StringIO()
        reporter = RunReporter("deepseek/deepseek-flash", False, output)

        reporter.consume(
            json.dumps({"type": "text", "part": {"text": "\u001b[31mred\u001b[0m"}})
        )

        self.assertNotIn("\u001b", output.getvalue())
        self.assertIn("red", output.getvalue())


if __name__ == "__main__":
    unittest.main()
