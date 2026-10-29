import copy
import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "qualification_executor", ROOT / "scripts/qualification-executor.py"
)
executor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(executor)


class QualificationIsolationTests(unittest.TestCase):
    def test_rejects_unverified_controls_before_starting_candidate_code(self):
        verified = {
            "HostConfig": {
                "NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                "Memory": executor.MEMORY, "MemorySwap": executor.MEMORY,
                "PidsLimit": 64, "NanoCpus": 500000000, "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges"],
                "Ulimits": [{"Name": "cpu", "Soft": 5, "Hard": 5}],
            },
            "Config": {"User": "65534:65534", "Entrypoint": ["/usr/bin/env"]},
            "Mounts": [{"RW": False}],
        }
        failures = [
            ("NetworkMode", "bridge"), ("ReadonlyRootfs", False),
            ("Memory", 0), ("MemorySwap", -1), ("PidsLimit", 0),
            ("NanoCpus", 0), ("CapDrop", []), ("SecurityOpt", []),
            ("Privileged", True), ("Ulimits", []), ("mount", True),
        ]
        for key, value in failures:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as root:
                inspection = copy.deepcopy(verified)
                if key == "mount":
                    inspection["Mounts"][0]["RW"] = value
                else:
                    inspection["HostConfig"][key] = value
                with patch.object(executor, "command", side_effect=[
                    "a" * 64, json.dumps([inspection]), "",
                ]) as command, patch.object(executor.subprocess, "Popen") as start:
                    with self.assertRaisesRegex(ValueError, "EXECUTOR_UNAVAILABLE"):
                        executor.execute(
                            "docker", {"PATH": "/usr/bin"}, "sha256:" + "b" * 64,
                            {"language": "python", "text": "print(4)", "blockIndex": 0},
                            Path(root), time.monotonic() + 10,
                        )
                    start.assert_not_called()
                    self.assertEqual(command.call_args.args[2], ["rm", "--force", "a" * 64])

    def test_refuses_to_start_work_after_the_shared_wall_deadline(self):
        with tempfile.TemporaryDirectory() as root, patch.object(executor, "command") as command:
            with self.assertRaisesRegex(ValueError, "EXECUTION_FAILED"):
                executor.execute("docker", {}, "sha256:" + "b" * 64, {}, Path(root), time.monotonic() - 1)
            command.assert_not_called()
