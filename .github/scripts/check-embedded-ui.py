#!/usr/bin/env python3
"""Prove a distributed binary serves its UI without source files or Node."""

import argparse
from contextlib import ExitStack
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import urljoin, urlsplit
from urllib.request import urlopen


class PageAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.styles = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "link" and values.get("rel") == "stylesheet":
            self.styles.append(values.get("href", ""))
        if tag == "script" and "src" in values:
            self.scripts.append(values["src"])


def install_binary(args, destination):
    if args.binary:
        shutil.copy2(Path(args.binary).resolve(strict=True), destination)
    else:
        with tarfile.open(Path(args.archive).resolve(strict=True), "r:gz") as archive:
            member = archive.getmember("herdr-agent")
            if not member.isfile():
                raise RuntimeError("release archive must contain a regular herdr-agent binary")
            # Extract only the binary, so other archive contents cannot hide
            # an accidental dependency on separately shipped frontend files.
            with archive.extractfile(member) as source, destination.open("wb") as target:
                shutil.copyfileobj(source, target)
    destination.chmod(0o700)


def ready_url(process):
    lines = []
    deadline = time.monotonic() + 20
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline:
            if not selector.select(timeout=0.25):
                if process.poll() is not None:
                    break
                continue
            line = process.stdout.readline()
            if not line:
                break
            lines.append(line.strip())
            match = re.search(r"http://127\.0\.0\.1:\d+", line)
            if match:
                return match.group(0)
    raise RuntimeError("configuration page did not start: " + " | ".join(lines[-8:]))


def get(url, mime):
    with urlopen(url, timeout=5) as response:
        data = response.read()
        if response.status != 200 or response.headers.get_content_type() != mime or not data:
            raise RuntimeError("missing or invalid embedded resource: " + urlsplit(url).path)
        return data


def check(args):
    with tempfile.TemporaryDirectory(prefix="herdr-embedded-ui-") as directory:
        root = Path(directory)
        binary = root / "herdr-agent"
        install_binary(args, binary)
        env = os.environ.copy()
        for name in ("FEISHU_APP_ID", "FEISHU_APP_SECRET"):
            env.pop(name, None)
        with ExitStack() as resources:
            process = subprocess.Popen(
                [str(binary), "--state-dir", str(root / "state"), "configure", "--listen", "127.0.0.1:0"],
                cwd=root,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
            )
            resources.callback(process.stdout.close)
            try:
                url = ready_url(process)
                page = get(url + "/", "text/html").decode("utf-8")
                if 'id="directory-list"' not in page or 'id="bypass-mode"' not in page:
                    raise RuntimeError("binary did not serve the project configuration page")
                if 'id="feishu-authorization"' not in page:
                    raise RuntimeError("binary omitted the Feishu authorization section")
                assets = PageAssets()
                assets.feed(page)
                if not assets.styles or not assets.scripts:
                    raise RuntimeError("configuration page omitted its styles or scripts")
                checked = []
                for paths, mime in ((assets.styles, "text/css"), (assets.scripts, "text/javascript")):
                    for path in paths:
                        target = urljoin(url + "/", path)
                        if not path or urlsplit(target).netloc != urlsplit(url).netloc or urlsplit(target).scheme != "http":
                            raise RuntimeError("frontend must use embedded local assets")
                        get(target, mime)
                        checked.append(path)
                data = json.loads(get(url + "/api/projects", "application/json"))
                if data.get("projects") != [] or data.get("bypass") is not True:
                    raise RuntimeError("standalone binary did not load isolated default configuration")
                auth = json.loads(get(url + "/api/feishu/authorization", "application/json"))
                if auth.get("state") != "disabled" or auth.get("url"):
                    raise RuntimeError("standalone configure claimed a startup permission check or login")
                if process.poll() is not None:
                    raise RuntimeError("configuration server exited during the check")
            finally:
                process.terminate()
                try:
                    returncode = process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise RuntimeError("configuration server failed to stop") from None
            if returncode != 0:
                raise RuntimeError("configuration server did not shut down cleanly")
    print(json.dumps({"embedded_ui": "passed", "assets": checked, "api": "/api/projects", "source_files_required": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--binary", help="compiled binary for this runner")
    source.add_argument("--archive", help="release .tar.gz for this runner")
    check(parser.parse_args())
