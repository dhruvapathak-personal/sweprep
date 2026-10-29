import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "local_stack", Path(__file__).resolve().parents[2] / "scripts/ci/local-stack.py"
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
        ci = patch.dict(os.environ, {"CI": "true"})
        ci.start()
        self.addCleanup(ci.stop)
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

    def test_requires_ci_selection_before_any_cli_process(self):
        for command in ["start", "stop", "prepare-test", "types"]:
            with patch.dict(os.environ, {"CI": ""}), patch.object(
                subprocess, "run"
            ) as execute:
                with self.assertRaisesRegex(ValueError, "CI-only"):
                    stack.run(command)
                execute.assert_not_called()

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

    def test_types_normalize_generator_trailing_whitespace(self):
        target = self.root / "lib" / "contracts"
        target.mkdir(parents=True)

        def cli(*args):
            if args == ("gen", "types", "typescript", "--local"):
                return "export type Database = {  \n  \n}\n"
            return self.cli(*args)

        with patch.object(stack, "cli", side_effect=cli):
            stack.run("types")
        self.assertEqual(
            (target / "database.types.ts").read_text(),
            "export type Database = {\n\n}\n",
        )

    def test_unsafe_engine_selection_cannot_invoke_any_cli_command(self):
        config = self.root / "docker-config"
        config.mkdir()
        (config / "config.json").write_text('{"currentContext":"remote"}')
        for selector in [
            {"DOCKER_HOST": "tcp://remote.example.test:2375"},
            {"DOCKER_HOST": "ssh://remote.example.test"},
            {"DOCKER_CONTEXT": "remote"},
            {"DOCKER_CONFIG": str(config)},
        ]:
            for command in ["start", "stop", "prepare-test", "types"]:
                with self.subTest(selector=selector, command=command):
                    with patch.dict(
                        os.environ,
                        {"DOCKER_HOST": "", "DOCKER_CONTEXT": "", "DOCKER_CONFIG": ""}
                        | selector,
                    ), patch.object(subprocess, "run") as execute:
                        with self.assertRaises(ValueError):
                            stack.run(command)
                        execute.assert_not_called()

    def test_local_socket_is_pinned_for_every_cli_subprocess(self):
        runtime = self.root / "runtime" / "podman"
        runtime.mkdir(parents=True)
        path = runtime / "podman.sock"
        engine = socket.socket(socket.AF_UNIX)
        self.addCleanup(engine.close)
        engine.bind(str(path))
        inherited_config = self.root / "docker-config"
        inherited_config.mkdir()
        (inherited_config / "config.json").write_text('{"currentContext":"remote"}')
        calls = []

        def execute(args, **kwargs):
            child_env = kwargs["env"]
            self.assertEqual(child_env["DOCKER_HOST"], f"unix://{path}")
            self.assertNotIn("DOCKER_CONTEXT", child_env)
            self.assertNotIn("DOCKER_TLS_VERIFY", child_env)
            self.assertNotIn("DOCKER_CERT_PATH", child_env)
            self.assertNotIn("PGHOSTADDR", child_env)
            isolated = Path(child_env["DOCKER_CONFIG"])
            self.assertNotEqual(isolated, inherited_config)
            self.assertEqual(
                json.loads((isolated / "config.json").read_text()),
                {"currentContext": "default"},
            )
            calls.append(args[1:])
            return subprocess.CompletedProcess(args, 0, self.cli(*args[1:]), "")

        with (
            patch.dict(
                os.environ,
                {
                    "DOCKER_HOST": f"unix://{path}",
                    "DOCKER_CONTEXT": "",
                    "DOCKER_CONFIG": str(inherited_config),
                    "DOCKER_TLS_VERIFY": "1",
                    "DOCKER_CERT_PATH": "/untrusted",
                    "PGHOSTADDR": "127.0.0.2",
                },
            ),
            patch.object(subprocess, "run", side_effect=execute),
        ):
            stack.run("prepare-test")
        self.assertEqual(
            calls,
            [
                ["--version"],
                ["status", "-o", "json"],
                ["db", "reset", "--local"],
                ["status", "-o", "json"],
            ],
        )


if __name__ == "__main__":
    unittest.main()
