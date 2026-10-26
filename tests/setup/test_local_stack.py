import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "local_stack", Path(__file__).resolve().parents[2] / "scripts/local-stack.py"
)
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)

STATUS = {
    "API_URL": "http://127.0.0.1:54321",
    "DB_URL": "postgresql://postgres:synthetic@127.0.0.1:54322/postgres",
    "ANON_KEY": "synthetic-public",
    "SERVICE_ROLE_KEY": "synthetic-private",
}


class LocalStackTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        root = patch.object(stack, "ROOT", self.root)
        root.start()
        self.addCleanup(root.stop)

    def cli(self, *args):
        if args == ("--version",):
            return stack.CLI_VERSION
        if args == ("status", "-o", "json"):
            return json.dumps(STATUS)
        return ""

    def test_private_env_does_not_overwrite_or_follow_symlinks(self):
        with patch.object(stack, "cli", side_effect=self.cli):
            stack.run("env")
            path = self.root / ".env.local"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertIn("GRADING_MODE=simulated", path.read_text())
            saved = path.read_text()
            with self.assertRaises(FileExistsError):
                stack.run("env")
            self.assertEqual(path.read_text(), saved)
            path.unlink()
            target = self.root / "unrelated"
            target.write_text("keep")
            path.symlink_to(target)
            with self.assertRaises(FileExistsError):
                stack.run("env")
            self.assertEqual(target.read_text(), "keep")

    def test_reset_rejects_hosted_or_nonstandard_status_before_destructive_command(self):
        for replacement in [
            {"API_URL": "https://project.supabase.co"},
            {"API_URL": "http://:synthetic@127.0.0.1:54321"},
            {"DB_URL": "postgresql://postgres:synthetic@host.test:54322/postgres"},
            {"DB_URL": "postgresql://postgres:synthetic@127.0.0.1:5432/postgres"},
        ]:
            def cli(*args):
                if args == ("status", "-o", "json"):
                    return json.dumps(STATUS | replacement)
                return self.cli(*args)
            with patch.object(stack, "cli", side_effect=cli) as command:
                with self.assertRaises(ValueError):
                    stack.run("prepare-test")
                self.assertNotIn(
                    ("db", "reset", "--local"),
                    [call.args for call in command.call_args_list],
                )
                self.assertFalse((self.root / ".supabase-test.json").exists())

    def test_preparation_writes_receipt_only_after_successful_reset(self):
        receipt = self.root / ".supabase-test.json"
        with patch.object(stack, "cli", side_effect=self.cli) as command:
            stack.run("prepare-test")
            command.assert_any_call("db", "reset", "--local")
            self.assertEqual(json.loads(receipt.read_text())["status"], STATUS)
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)

        def failing(*args):
            if args == ("db", "reset", "--local"):
                raise ValueError("Reset failed")
            return self.cli(*args)
        with patch.object(stack, "cli", side_effect=failing):
            with self.assertRaises(ValueError):
                stack.run("prepare-test")
        self.assertFalse(receipt.exists())

    def test_cli_version_mismatch_cannot_start_services(self):
        with patch.object(stack, "cli", return_value="1.0.0") as command:
            with self.assertRaises(ValueError):
                stack.run("start")
            command.assert_called_once_with("--version")


if __name__ == "__main__":
    unittest.main()
