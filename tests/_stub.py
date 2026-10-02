"""Shared fixtures for the backend tests.

Installs one `decky` stub module for the whole test process so that `main`
(which binds the module on first import) and every test file see the same
object, whatever the import order.
"""

import asyncio
import os
import sys
import types
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class RecordingLogger:
    def __init__(self):
        self.records: list[tuple[str, str]] = []

    def _log(self, level, args):
        self.records.append((level, " ".join(str(a) for a in args)))

    def info(self, *args):
        self._log("info", args)

    def error(self, *args):
        self._log("error", args)

    def warning(self, *args):
        self._log("warning", args)

    def debug(self, *args):
        self._log("debug", args)

    def messages(self, level=None):
        return [m for lv, m in self.records if level is None or lv == level]


def _make_stub():
    stub = types.ModuleType("decky")
    stub.DECKY_PLUGIN_SETTINGS_DIR = "/tmp/test_autoupdate"
    stub.DECKY_PLUGIN_DIR = "/tmp/test_autoupdate_plugin"
    stub.logger = RecordingLogger()
    return stub


if "decky" not in sys.modules:
    sys.modules["decky"] = _make_stub()

decky_stub = sys.modules["decky"]


def run(coro):
    return asyncio.run(coro)


def mock_process(stdout=b"", stderr=b"", returncode=0):
    proc = MagicMock()
    proc.communicate = AsyncMock(return_value=(stdout, stderr))
    proc.wait = AsyncMock(return_value=returncode)
    proc.returncode = returncode
    return proc


class FakeExec:
    """Argv-aware stand-in for asyncio.create_subprocess_exec.

    Rules are matched in order; a rule matches when every needle is an element
    of argv. A list of stdout values is consumed one per matching call (the
    last value repeats). Unmatched commands succeed with empty output.
    """

    def __init__(self, delay=0.0):
        self.rules = []
        self.calls: list[list[str]] = []
        self.kwargs: list[dict] = []
        self.delay = delay
        self.active = 0
        self.max_active = 0

    def when(self, *needles, stdout="", stderr="", rc=0, raises=None):
        outs = stdout if isinstance(stdout, list) else [stdout]
        self.rules.append({"needles": needles, "stdout": outs, "stderr": stderr, "rc": rc, "raises": raises, "hits": 0})
        return self

    def count(self, *needles):
        return sum(1 for argv in self.calls if all(n in argv for n in needles))

    def argvs(self, *needles):
        return [argv for argv in self.calls if all(n in argv for n in needles)]

    async def __call__(self, *argv, **kwargs):
        argv = list(argv)
        self.calls.append(argv)
        self.kwargs.append(kwargs)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
        finally:
            self.active -= 1
        for rule in self.rules:
            if all(n in argv for n in rule["needles"]):
                if rule["raises"] is not None:
                    raise rule["raises"]
                outs = rule["stdout"]
                out = outs[min(rule["hits"], len(outs) - 1)]
                rule["hits"] += 1
                return mock_process(out.encode(), rule["stderr"].encode(), rule["rc"])
        return mock_process()
