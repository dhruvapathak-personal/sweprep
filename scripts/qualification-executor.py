#!/usr/bin/env python3
"""Disposable code execution; no provider or database credentials enter this process."""

import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

MEMORY = 256 * 1024 * 1024
OUTPUT = 64 * 1024
PROBE = """
import os, pathlib, resource, sys
p = pathlib.Path('/sys/fs/cgroup')
assert int((p/'memory.max').read_text()) <= 268435456
assert int((p/'memory.swap.max').read_text()) == 0
assert int((p/'pids.max').read_text()) <= 64
quota, period = map(int, (p/'cpu.max').read_text().split())
assert quota / period <= 0.5
assert resource.getrlimit(resource.RLIMIT_CPU) == (5, 5)
assert os.statvfs('/').f_flag & os.ST_RDONLY
assert set(os.listdir('/sys/class/net')) == {'lo'}
assert set(os.environ) <= {'PATH', 'HOME', 'LANG', 'LC_CTYPE'}
status = pathlib.Path('/proc/self/status').read_text()
assert int(status.split('CapEff:')[1].split()[0], 16) == 0
assert int(status.split('NoNewPrivs:')[1].split()[0]) == 1
os.execvpe(sys.argv[1], sys.argv[1:], dict(os.environ))
"""


def command(engine, env, args):
    result = subprocess.run(
        [engine, *args], env=env, capture_output=True, timeout=10, check=False
    )
    if result.returncode:
        raise ValueError("EXECUTOR_UNAVAILABLE")
    return result.stdout.decode()


def execute(engine, env, image, block, directory, deadline):
    if time.monotonic() >= deadline:
        raise ValueError("EXECUTION_FAILED")
    suffix = {"python": "py", "cpp": "cpp"}.get(block["language"])
    if not suffix or len(block["text"].encode()) > 20000:
        raise ValueError("EXECUTION_FAILED")
    path = directory / f"program.{suffix}"
    path.write_text(block["text"])
    path.chmod(0o444)
    invocation = (
        ["python3", "-I", "-B", f"/input/program.{suffix}"]
        if suffix == "py"
        else ["sh", "-c", "c++ -std=c++20 -O0 /input/program.cpp -o /tmp/program && /tmp/program"]
    )
    args = [
        "create", "--pull=never", "--network=none", "--read-only",
        "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        f"--memory={MEMORY}", f"--memory-swap={MEMORY}", "--pids-limit=64", "--cpus=0.5",
        "--ulimit=cpu=5:5", "--ulimit=nofile=64:64",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216",
        "--mount", f"type=bind,src={path},dst=/input/program.{suffix},readonly",
        "--log-driver=none", "--entrypoint=/usr/bin/env",
        image, "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8",
        "python3", "-I", "-c", PROBE, *invocation,
    ]
    if suffix == "cpp":
        args[args.index("--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216")] = (
            "--tmpfs=/tmp:rw,nosuid,nodev,size=16777216"
        )
    container = command(engine, env, args).strip()
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("EXECUTOR_UNAVAILABLE")
    try:
        info = json.loads(command(engine, env, ["inspect", container]))[0]
        host = info["HostConfig"]
        if (
            host["NetworkMode"] != "none" or not host["ReadonlyRootfs"]
            or host["Privileged"] or host["Memory"] != MEMORY
            or host["MemorySwap"] != MEMORY or host["PidsLimit"] != 64
            or host["NanoCpus"] != 500000000
            or "ALL" not in host["CapDrop"]
            or not any("no-new-privileges" in value for value in host["SecurityOpt"])
            or info["Config"]["User"] != "65534:65534"
            or info["Config"]["Entrypoint"] != ["/usr/bin/env"]
            or not any(limit["Name"] == "cpu" and limit["Soft"] == 5 and limit["Hard"] == 5 for limit in host["Ulimits"])
            or len(info["Mounts"]) != 1 or info["Mounts"][0]["RW"]
        ):
            raise ValueError("EXECUTOR_UNAVAILABLE")
        if time.monotonic() >= deadline:
            raise ValueError("EXECUTION_FAILED")
        process = subprocess.Popen(
            [engine, "start", "--attach", container], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        output = bytearray()
        start = time.monotonic()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if time.monotonic() >= deadline:
                        raise ValueError("EXECUTION_FAILED")
                    for key, _ in selector.select(0.1):
                        data = os.read(key.fileobj.fileno(), 8192)
                        if not data:
                            selector.unregister(key.fileobj)
                        else:
                            output.extend(data)
                            if len(output) > OUTPUT:
                                raise ValueError("EXECUTION_FAILED")
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
            state = json.loads(command(engine, env, ["inspect", container]))[0]["State"]
            if state["Running"] or state["OOMKilled"]:
                raise ValueError("EXECUTION_FAILED")
            return {
                "blockIndex": block["blockIndex"], "exitCode": state["ExitCode"],
                "stdout": output.decode("utf8", errors="strict"),
                "elapsedMs": round((time.monotonic() - start) * 1000),
                "imageId": info["Image"],
            }
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
    finally:
        command(engine, env, ["rm", "--force", container])


def main():
    mode = os.environ.get("QUALIFICATION_EXECUTOR", "")
    image = os.environ.get("QUALIFICATION_EXECUTOR_IMAGE", "")
    if mode not in ("podman", "docker-ci") or (mode == "docker-ci" and os.environ.get("CI") != "true"):
        raise ValueError("EXECUTOR_UNAVAILABLE")
    if not re.fullmatch(r"(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}", image):
        raise ValueError("EXECUTOR_UNAVAILABLE")
    data = json.loads(sys.stdin.buffer.read(100001))
    if data["toolchainVersion"] != f"disposable-v1@{image}" or not 1 <= len(data["blocks"]) <= 20:
        raise ValueError("EXECUTOR_UNAVAILABLE")
    engine = "podman" if mode == "podman" else "docker"
    env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8"}
    if engine == "podman":
        if os.environ.get("XDG_RUNTIME_DIR"):
            env["XDG_RUNTIME_DIR"] = os.environ["XDG_RUNTIME_DIR"]
        info = json.loads(command(engine, env, ["info", "--format=json"]))
        if not info["host"]["security"]["rootless"] or info["host"]["cgroupVersion"] != "v2":
            raise ValueError("EXECUTOR_UNAVAILABLE")
    else:
        endpoint = urlsplit(os.environ.get("DOCKER_HOST", "unix:///var/run/docker.sock"))
        if endpoint.scheme != "unix" or endpoint.netloc or not Path(endpoint.path).is_socket():
            raise ValueError("EXECUTOR_UNAVAILABLE")
        env["DOCKER_HOST"] = f"unix://{endpoint.path}"
    with tempfile.TemporaryDirectory(prefix="qualification-") as root:
        directory = Path(root)
        directory.chmod(0o755)
        config = directory / "engine"
        config.mkdir()
        (config / "config.json").write_text('{"currentContext":"default"}')
        if engine == "docker":
            env["DOCKER_CONFIG"] = str(config)
        command(engine, env, ["image", "inspect", image])
        deadline = time.monotonic() + 10
        results = [execute(engine, env, image, block, directory, deadline) for block in data["blocks"]]
        if sum(len(result["stdout"].encode()) for result in results) > OUTPUT:
            raise ValueError("EXECUTION_FAILED")
    print(json.dumps({
        "status": "executed", "isolation": "network-disabled-v1",
        "toolchainVersion": data["toolchainVersion"], "cpuSeconds": 5,
        "wallSeconds": 10, "memoryBytes": MEMORY, "outputBytes": OUTPUT,
        "readOnly": True, "credentialFree": True, "results": results,
    }))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError):
        print("EXECUTOR_UNAVAILABLE", file=sys.stderr)
        sys.exit(1)
