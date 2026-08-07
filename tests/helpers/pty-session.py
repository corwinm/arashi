#!/usr/bin/env python3
"""Run a command with terminal stdin, split output capture, and prove PTY reuse."""

import base64
import errno
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

REUSE_PROMPT = "__ARASHI_PTY_REUSE_PROMPT__"
REUSE_ANSWER = "arashi-terminal-reused"


def read_bytes(path: str) -> bytes:
    try:
        with open(path, "rb") as stream:
            return stream.read()
    except FileNotFoundError:
        return b""


def session_child(config: dict) -> None:
    os.chdir(config["cwd"])
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    started = time.monotonic()
    with open(config["stdoutPath"], "wb", buffering=0) as stdout_stream, open(
        config["stderrPath"], "wb", buffering=0
    ) as stderr_stream:

        def restore_interrupt() -> None:
            signal.signal(signal.SIGINT, signal.SIG_DFL)

        proc = subprocess.Popen(
            config["command"],
            stdin=sys.stdin.buffer,
            stdout=stdout_stream,
            stderr=stderr_stream,
            preexec_fn=restore_interrupt,
        )
        exit_code = proc.wait()

    tty = os.open("/dev/tty", os.O_RDWR)
    try:
        os.write(tty, REUSE_PROMPT.encode())
        reused = os.read(tty, 4096).decode(errors="replace").strip() == REUSE_ANSWER
        os.write(tty, f"__ARASHI_PTY_REUSED__:{str(reused).lower()}\n".encode())
    finally:
        os.close(tty)

    result = {
        "durationMs": round((time.monotonic() - started) * 1000),
        "exitCode": exit_code,
        "reused": reused,
        "stderrBase64": base64.b64encode(read_bytes(config["stderrPath"])).decode(),
        "stdoutBase64": base64.b64encode(read_bytes(config["stdoutPath"])).decode(),
    }
    with open(config["resultPath"], "w", encoding="utf8") as result_stream:
        json.dump(result, result_stream)
    raise SystemExit(0 if reused else 126)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pty-session.py <config-json>", file=sys.stderr)
        return 2
    config = json.loads(sys.argv[1])
    for key in (
        "command",
        "cwd",
        "prompt",
        "response",
        "resultPath",
        "stderrPath",
        "stdoutPath",
        "timeoutSeconds",
    ):
        if key not in config:
            raise ValueError(f"missing config key: {key}")

    for path in (config["stdoutPath"], config["stderrPath"]):
        with open(path, "wb"):
            pass

    pid, master = pty.fork()
    if pid == 0:
        session_child(config)

    prompt = config["prompt"].encode()
    response = config["response"]
    prompt_observed = False
    reuse_observed = False
    terminal_output = bytearray()
    deadline = time.monotonic() + float(config["timeoutSeconds"])
    status = None

    try:
        while time.monotonic() < deadline:
            combined = read_bytes(config["stdoutPath"]) + read_bytes(config["stderrPath"])
            if not prompt_observed and prompt in combined:
                prompt_observed = True
                if response == "__CTRL_C__":
                    os.write(master, b"\x03")
                elif response != "__NO_INPUT__":
                    os.write(master, response.encode() + b"\n")

            ready, _, _ = select.select([master], [], [], 0.02)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        chunk = b""
                    else:
                        raise
                if chunk:
                    terminal_output.extend(chunk)
                    if not reuse_observed and REUSE_PROMPT.encode() in terminal_output:
                        reuse_observed = True
                        os.write(master, REUSE_ANSWER.encode() + b"\n")

            finished, candidate = os.waitpid(pid, os.WNOHANG)
            if finished == pid:
                status = candidate
                break

        if status is None:
            os.killpg(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            print("PTY session exceeded harness timeout", file=sys.stderr)
            return 124
    finally:
        os.close(master)

    if not prompt_observed:
        print(f"PTY prompt was not observed: {config['prompt']}", file=sys.stderr)
        return 125
    if not reuse_observed:
        print("PTY terminal reuse prompt was not observed", file=sys.stderr)
        return 126
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
