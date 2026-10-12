"""Windows guarantees that can be checked from any OS: the CI box is not Windows, so each rule
that only bites there is pinned here instead of being rediscovered on a user's machine."""
from __future__ import annotations

import ntpath
import os
import re
from pathlib import Path

import pytest

from app import main

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ["install-windows.bat", "start-windows.bat", "serve-windows.bat"]


def test_static_check_survives_paths_on_another_drive(monkeypatch: pytest.MonkeyPatch) -> None:
    # Windows' commonpath raises ValueError across drives ("/D:/secret"): that must read as
    # "outside the build", never as a 500.
    monkeypatch.setattr(os.path, "commonpath", ntpath.commonpath)
    assert main._inside(r"C:\factory\dist", r"D:\secret.txt") is False
    assert main._inside(r"C:\factory\dist", r"C:\factory\dist\assets\app.js") is True
    assert main._inside(r"C:\factory\dist", r"C:\factory\dist2\app.js") is False


@pytest.mark.parametrize("name", SCRIPTS)
def test_batch_scripts_use_crlf(name: str) -> None:
    # cmd.exe misreads labels and blocks in a batch file with bare LF endings.
    raw = (ROOT / name).read_bytes()
    assert b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"")


@pytest.mark.parametrize("name", ["start-windows.bat", "serve-windows.bat"])
def test_api_never_starts_with_reload_on_windows(name: str) -> None:
    # uvicorn --reload switches Windows to the Selector loop, which cannot spawn the stdio MCP servers.
    text = (ROOT / name).read_text(encoding="utf-8")
    assert "-m app" in text
    assert not re.search(r"^[^:\n]*--reload", text, re.M)


def test_tzdata_is_required_on_windows() -> None:
    # Windows ships no IANA zones: without tzdata, Europe/Paris silently becomes UTC.
    reqs = (ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(r'^tzdata\S*;\s*sys_platform\s*==\s*"win32"', reqs, re.M)


def test_gitattributes_pins_crlf_for_batch_files() -> None:
    assert "*.bat text eol=crlf" in (ROOT / ".gitattributes").read_text(encoding="utf-8")
