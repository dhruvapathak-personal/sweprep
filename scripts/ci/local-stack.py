#!/usr/bin/env python3
"""CI-only isolated Supabase lifecycle; requires Python 3.10+ and native CLI."""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
CLI_VERSION = "2.122.0"


def cli(*args):
    if os.environ.get("DOCKER_CONTEXT", "") not in ("", "default"):
        raise ValueError("Select a local Unix socket with DOCKER_HOST, not DOCKER_CONTEXT.")
    host = os.environ.get("DOCKER_HOST")
    if not host:
        config = Path(os.environ.get("DOCKER_CONFIG") or Path.home() / ".docker")
        settings = config / "config.json"
        if settings.exists() and json.loads(settings.read_text()).get(
            "currentContext"
        ) not in (None, "", "default"):
            raise ValueError("Select a local Unix socket explicitly with DOCKER_HOST.")
        host = "unix:///var/run/docker.sock"
    endpoint = urlsplit(host)
    if (
        endpoint.scheme != "unix"
        or endpoint.netloc
        or not Path(endpoint.path).is_absolute()
        or endpoint.query
        or endpoint.fragment
        or "%" in host
    ):
        raise ValueError("Only a local Unix engine socket is permitted.")
    engine_socket = Path(endpoint.path).resolve(strict=True)
    if not engine_socket.is_socket():
        raise ValueError("The local engine endpoint must be a Unix socket.")
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("DOCKER_", "PG"))
        and key not in ("CONTAINER_HOST", "CONTAINER_CONNECTION")
    }
    env["DOCKER_HOST"] = f"unix://{engine_socket}"
    # Supabase initializes Docker before validating even non-destructive commands.
    with TemporaryDirectory(prefix="sweprep-engine-") as isolated_config:
        (Path(isolated_config) / "config.json").write_text('{"currentContext":"default"}')
        env["DOCKER_CONFIG"] = isolated_config
        result = subprocess.run(
            ["supabase", *args],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode:
        raise ValueError("Supabase command failed. Check the host engine and local stack.")
    return result.stdout


def local_status():
    status = json.loads(cli("status", "-o", "json"))
    api = urlsplit(status["API_URL"])
    db = urlsplit(status["DB_URL"])
    if (
        api.scheme != "http"
        or api.hostname != "127.0.0.1"
        or api.port != 54321
        or api.path not in ("", "/")
        or api.username
        or api.password
        or api.query
        or api.fragment
        or db.scheme != "postgresql"
        or db.hostname != "127.0.0.1"
        or db.port != 54322
        or db.path != "/postgres"
        or db.username != "postgres"
        or db.query
        or db.fragment
    ):
        raise ValueError("Only the loopback sweprep Supabase stack is permitted.")
    if not status.get("ANON_KEY") or not status.get("SERVICE_ROLE_KEY"):
        raise ValueError("Local Supabase keys are missing.")
    return status


def private_file(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)


def run(command):
    if os.environ.get("CI") != "true":
        raise ValueError("CI-only local services require CI=true.")
    if cli("--version").strip() != CLI_VERSION:
        raise ValueError(f"CI requires native Supabase CLI {CLI_VERSION}.")
    receipt = ROOT / ".supabase-test.json"
    if command == "start":
        cli("start")
    elif command == "stop":
        receipt.unlink(missing_ok=True)
        cli("stop")
    elif command == "prepare-test":
        receipt.unlink(missing_ok=True)
        local_status()
        cli("db", "reset", "--local")
        private_file(
            receipt,
            json.dumps({"status": local_status(), "preparedAt": time.time()}),
        )
    elif command == "types":
        local_status()
        types = cli("gen", "types", "typescript", "--local")
        types = "\n".join(line.rstrip() for line in types.splitlines()) + "\n"
        (ROOT / "lib/contracts/database.types.ts").write_text(types)
    print(f"Local Supabase {command} complete. No credentials printed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["start", "stop", "prepare-test", "types"]
    )
    try:
        run(parser.parse_args().command)
    except (ValueError, OSError, KeyError):
        parser.exit(
            1,
            "CI setup failed. Check CI=true, CLI 2.122.0, local Unix DOCKER_HOST, default "
            "DOCKER_CONTEXT, ports 54320–54324 "
            "and the private reset receipt. Hosted services are not permitted.\n",
        )
