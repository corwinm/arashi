#!/usr/bin/env python3
"""Run a command in a controlling PTY and react only after a prompt is visible."""

import errno
import json
import os
import pty
import select
import signal
import sys
import time


def main() -> int:
    if len(sys.argv) != 6:
        print(
            "usage: pty-command.py <cwd> <prompt> <response|__CTRL_C__|__NO_INPUT__> <timeout-seconds> <command-json>",
            file=sys.stderr,
        )
        return 2

    cwd, prompt_text, response, timeout_text, command_json = sys.argv[1:]
    command = json.loads(command_json)
    if not isinstance(command, list) or not command:
        raise ValueError("command-json must be a non-empty string array")

    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(command[0], command, os.environ)

    prompt = prompt_text.encode()
    output = bytearray()
    responded = False
    deadline = time.monotonic() + float(timeout_text)
    status = None
    pty_eof = False

    try:
        while time.monotonic() < deadline:
            if not pty_eof:
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    try:
                        chunk = os.read(master, 4096)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            pty_eof = True
                            chunk = b""
                        else:
                            raise
                    if chunk:
                        output.extend(chunk)
                        os.write(sys.stdout.fileno(), chunk)
                        if not responded and prompt in output:
                            responded = True
                            if response == "__CTRL_C__":
                                os.write(master, b"\x03")
                            elif response != "__NO_INPUT__":
                                os.write(master, response.encode() + b"\n")
            else:
                time.sleep(0.01)

            finished, candidate = os.waitpid(pid, os.WNOHANG)
            if finished == pid:
                status = candidate
                break

        if status is None:
            os.killpg(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            print("PTY command exceeded harness timeout", file=sys.stderr)
            return 124
    finally:
        os.close(master)

    if not responded:
        print(f"PTY prompt was not observed: {prompt_text}", file=sys.stderr)
        return 125
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
