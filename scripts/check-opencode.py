"""Exercise the packed plugin in the official OpenCode TUI on Linux."""

import argparse
import errno
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tarfile
import tempfile
import termios
from threading import Event, Thread
import time

import pyte


PACKAGE = "opencode2-enhanced-composer"
WORKSPACE_NAME = "composer-runtime-project"
MARKER = "[composer]"
RELOADED_MARKER = "[reloaded]"
MODEL = "Composer Fixture Model"
TPS_PATTERN = re.compile(r"~[\d.]+ t/s")
COLUMNS = 144
ROWS = 46


class Terminal:
    def __init__(self, binary, workspace, env):
        self.screen = pyte.Screen(COLUMNS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        self.master, slave = pty.openpty()
        self.trace = workspace.parent / "terminal.log"
        self.output = self.trace.open("wb")
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0))
            self.process = subprocess.Popen(
                [binary, "--standalone", "--log-level", "warn"],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=workspace,
                env=env,
                start_new_session=True,
            )
        finally:
            os.close(slave)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        finally:
            os.close(self.master)
            self.output.close()

    def send(self, keys):
        os.write(self.master, keys)

    def frame(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def wait_for(self, predicate, description, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(self.frame()):
                return self.frame()
            if self.process.poll() is not None:
                break
            if not select.select([self.master], [], [], 0.1)[0]:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            self.output.write(data)
            self.stream.feed(data)
        self.output.flush()
        raise AssertionError(f"Expected {description}\n{self.frame()}\nLast terminal output: {self.trace.read_bytes()[-1500:]!r}")

    def open_settings(self):
        self.send(b"/customize-footer")
        self.wait_for(lambda frame: "Footer and composer-top widgets" in frame, "the plugin command in slash completion")
        self.send(b"\r")
        self.wait_for(lambda frame: "Preview" in frame and "[1] Layout" in frame, "the footer editor and preview")

    def prompt(self, text):
        self.send(text.encode())
        self.wait_for(lambda frame: text in frame, "prompt input")
        self.send(b"\r")


class FixtureModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return

        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        last = body["messages"][-1]
        content = str(last.get("content"))
        title = "Reply with only the title." in content or any(
            message["role"] == "system" and "You are a title generator." in str(message.get("content"))
            for message in body["messages"]
        )
        input_tokens, output_tokens = (0, 0) if title else (100, 20)
        usage = {"prompt_tokens": input_tokens, "completion_tokens": output_tokens,
                 "total_tokens": input_tokens + output_tokens}
        response = {"id": "composer-fixture", "model": body["model"], "created": 0}
        if not body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                **response, "object": "chat.completion", "usage": usage,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Composer fixture"}, "finish_reason": "stop"}],
            }).encode())
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def event(*, delta=None, finish=None):
            choices = [] if delta is None else [{"index": 0, "delta": delta, "finish_reason": finish}]
            chunk = {**response, "object": "chat.completion.chunk", "choices": choices}
            if delta is None:
                chunk["usage"] = usage
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()

        if title:
            event(delta={"role": "assistant", "content": "Composer runtime check"})
            event(delta={}, finish="stop")
        elif last["role"] == "tool":
            event(delta={"role": "assistant", "content": "Parent continues while the child works."})
            event(delta={}, finish="stop")
        elif "start a fixture subagent" in content:
            event(delta={"role": "assistant", "tool_calls": [{
                "index": 0, "id": "composer-subagent", "type": "function",
                "function": {"name": "subagent", "arguments": json.dumps({
                    "agent": "explore", "description": "Composer test child", "prompt": "wait for the fixture signal",
                })},
            }]})
            event(delta={}, finish="tool_calls")
        elif "wait for the fixture signal" in content:
            if not self.server.release_child.wait(30):
                return
            event(delta={"role": "assistant", "content": "Fixture child completed."})
            event(delta={}, finish="stop")
        elif "stream a fixture response" in content:
            event(delta={"role": "assistant", "content": "Composer fixture is streaming. "})
            time.sleep(0.35)
            event(delta={"content": "The next portion has arrived. "})
            if not self.server.release_stream.wait(30):
                return
            event(delta={"content": "Fixture response complete."})
            event(delta={}, finish="stop")
        else:
            event(delta={"role": "assistant", "content": "Composer fixture"})
            event(delta={}, finish="stop")

        event()
        self.wfile.write(b"data: [DONE]\n\n")


class FixtureServer(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), FixtureModel)
        self.release_stream = Event()
        self.release_child = Event()

    def __enter__(self):
        self.thread = Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.release_stream.set()
        self.release_child.set()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=5)

    def config(self):
        return {
            "model": "fixture/chat",
            "permissions": [{"action": "subagent", "resource": "explore", "effect": "allow"}],
            "providers": {
                "fixture": {
                    "name": "Fixture", "package": "aisdk:@ai-sdk/openai-compatible",
                    "settings": {"apiKey": "local-test", "baseURL": f"http://127.0.0.1:{self.server_port}/v1"},
                    "models": {"chat": {
                        "name": MODEL, "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                        "cost": {"input": 1000, "output": 1000},
                        "limit": {"context": 100000, "output": 10000},
                    }},
                },
            },
        }


def isolated_environment(root):
    home = root / "home"
    home.mkdir()
    (root / "tmp").mkdir()
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "LC_CTYPE") if key in os.environ}
    return {
        **env,
        "HOME": str(home),
        "TMPDIR": str(root / "tmp"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_STATE_HOME": str(root / "state"),
        "XDG_DATA_HOME": str(root / "data"),
        "OPENCODE_CONFIG_DIR": str(root / "cli-config"),
        "OPENCODE_DISABLE_MODELS_FETCH": "1",
        "OPENCODE_DISABLE_AUTOUPDATE": "1",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
    }


def install(pack, directory):
    directory.mkdir(parents=True)
    subprocess.run(
        ["npm", "install", "--prefix", str(directory), "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
         "--prefer-offline", str(pack)],
        check=True,
        timeout=120,
    )


def save_config(file, config):
    temporary = file.with_suffix(".new")
    temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    temporary.replace(file)


def check_package(package):
    expected = {"package.json", "LICENSE", "README.md", "options.schema.json", "dist/tui.js"}
    with tarfile.open(package, "r:gz") as archive:
        files = set()
        for member in archive:
            prefix, _, path = member.name.partition("/")
            assert prefix == "package" and member.isfile(), member.name
            assert path in expected or re.fullmatch(r"dist/[\w-]+\.js", path), path
            files.add(path)
        assert expected <= files, expected - files
        manifest = json.load(archive.extractfile("package/package.json"))
        assert manifest["exports"]["./tui"] == "./dist/tui.js", manifest["exports"]
        assert set(manifest["dependencies"]) == {"jsonc-parser", "string-width"}, manifest["dependencies"]


def check_session(terminal, fixture, background):
    terminal.prompt("stream a fixture response")
    terminal.wait_for(lambda frame: "Running" in frame and TPS_PATTERN.search(frame), "the session-top spinner and live TPS")
    fixture.release_stream.set()
    terminal.wait_for(
        lambda frame: "Fixture response complete." in frame and "Running" not in frame and TPS_PATTERN.search(frame)
        and any("in 100" in line and "out 20" in line and "$0.12" in line and "120 context" in line for line in frame.splitlines()),
        "the frozen TPS, token counts, cost and context in the footer after the stream",
    )

    if background:
        terminal.prompt("start a fixture subagent")
        terminal.wait_for(
            lambda frame: "1 agent" in frame and "Parent continues while the child works." in frame and "Running" not in frame,
            "the running child count after the parent becomes idle",
        )
        fixture.release_child.set()
        terminal.wait_for(lambda frame: "1 agent" not in frame, "the child count clearing when the child becomes idle")


def check_ui(binary, parent, package, background=False, source=None):
    parent.mkdir()
    env = isolated_environment(parent)
    workspace = parent / WORKSPACE_NAME
    workspace.mkdir()
    config_path = Path(env["OPENCODE_CONFIG_DIR"]) / "cli.json"
    if source is None:
        cache = Path(env["XDG_CACHE_HOME"]) / "opencode" / "npm" / f"{PACKAGE}@latest" / "1700000000000"
        install(package, cache)
        subprocess.run(
            [binary, "plugin", "add", PACKAGE], cwd=workspace, env=env, check=True, timeout=30,
        )
        config = json.loads(config_path.read_text(encoding="utf-8"))
        assert config["plugins"] == [PACKAGE], config
        plugin = PACKAGE
    else:
        config_path.parent.mkdir()
        config = {}
        plugin = str(source)

    config["plugins"] = [{
        "package": plugin,
        "options": {"appearance": {"spinner": "blocks", "directory": {"icon": {"text": MARKER}}}},
    }]
    save_config(config_path, config)

    with FixtureServer() as fixture:
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(fixture.config())
        check_terminal(binary, workspace, env, config_path, fixture, background, source)


def check_terminal(binary, workspace, env, config_path, fixture, background, source):
    with Terminal(binary, workspace, env) as terminal:
        terminal.wait_for(lambda frame: f"{MARKER} {WORKSPACE_NAME}" in frame and MODEL in frame, "the configured prompt footer and local model")
        terminal.open_settings()
        terminal.send(b"2")
        terminal.wait_for(lambda frame: any("› Spinner" in line for line in frame.splitlines()), "focus on the spinner setting")
        terminal.send(b"\x1b[C")
        terminal.wait_for(lambda frame: "1 unsaved" in frame and "› Spinner" in frame, "the edited spinner setting")
        terminal.send(b"s")
        terminal.wait_for(
            lambda frame: "Preview" not in frame
            and json.loads(config_path.read_text(encoding="utf-8"))["plugins"][0]["options"]["appearance"]["spinner"] == "text",
            "the saved spinner setting and the closed editor",
        )
        saved = json.loads(config_path.read_text(encoding="utf-8"))
        saved["plugins"][0]["options"]["appearance"]["directory"]["icon"]["text"] = RELOADED_MARKER
        save_config(config_path, saved)
        terminal.wait_for(
            lambda frame: f"{RELOADED_MARKER} {WORKSPACE_NAME}" in frame and f"{MARKER} {WORKSPACE_NAME}" not in frame,
            "the new footer after a live cli.json replacement",
        )
        terminal.open_settings()
        terminal.send(b"\x1b")
        terminal.wait_for(lambda frame: "Preview" not in frame, "the editor closing with Escape")
        if source is None:
            check_session(terminal, fixture, background)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="the official OpenCode 2 release to exercise")
    parser.add_argument("package", type=Path, help="the plugin tarball from npm pack")
    parser.add_argument("--binary", type=Path, help="use an already installed official CLI executable")
    parser.add_argument("--source", type=Path, help="also exercise a local plugin directory")
    parser.add_argument("--background", action="store_true", help="exercise the OpenCode 2.3 background subagent tool")
    args = parser.parse_args()
    if not re.fullmatch(r"2\.[0-9]+\.[0-9]+", args.version):
        parser.error("version must be a stable OpenCode 2 version")

    check_package(args.package)
    with tempfile.TemporaryDirectory(prefix="enhanced-composer-runtime-") as directory:
        root = Path(directory).resolve()
        binary = args.binary
        if binary is None:
            host = root / "host"
            install(f"@opencode/cli-linux-x64@{args.version}", host)
            binary = host / "node_modules" / "@opencode" / "cli-linux-x64" / "bin" / "opencode"
        binary = binary.resolve()
        reported = subprocess.check_output([binary, "--version"], text=True, timeout=15).strip()
        assert reported == f"opencode v{args.version}", reported
        check_ui(binary, root / "packed", args.package.resolve(), background=args.background)
        print(f"OpenCode {args.version}: packed plugin, footer, editor save, config reload and streamed session passed", flush=True)
        if args.background:
            print(f"OpenCode {args.version}: background subagent count after the parent goes idle passed", flush=True)
        if args.source:
            check_ui(binary, root / "source", args.package.resolve(), source=args.source.resolve())
            print(f"OpenCode {args.version}: source-directory load, editor save and config reload passed", flush=True)


if __name__ == "__main__":
    main()
