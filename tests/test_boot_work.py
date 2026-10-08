"""Boot work starts in the process that serves (2026-10-05): the retention sweep and both
warm-ups (the held day, the cover cache) start on the server's first request, never at
import. Render runs gunicorn with --preload, so the import happens in the gunicorn
master, which forks the worker and never serves: a thread started at import lived
there, and the day the warm-up held was one no reader saw.

Pinned here:
  * importing server starts no background thread (a fresh process, pool + covers +
    sweep all switched on, pointed at an empty data dir);
  * the server's first request starts each one, once — later requests and concurrent
    first requests don't start them again;
  * one that fails to start neither fails the request nor stops the others;
  * apps the tests build with create_app() start none of it.
"""
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

import server

ROOT = Path(__file__).resolve().parent.parent
BOOT = ["_start_retention_sweep", "_maybe_warm_pool", "_maybe_warm_covers"]


@pytest.fixture()
def starts(monkeypatch):
    calls = []
    for name in BOOT:
        monkeypatch.setattr(server, name, (lambda n: lambda: calls.append(n))(name))
    monkeypatch.setattr(server, "_boot_started", False)
    return calls


def test_importing_the_server_starts_no_thread(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("AOTD_")}
    env.update(AOTD_DATA_DIR=str(tmp_path), AOTD_USE_POOL="1", AOTD_COVER_CACHE="1",
               AOTD_RETENTION_SWEEP="1", AOTD_PREFETCH="0")
    probe = ("import threading, server; "
             "print(sorted(t.name for t in threading.enumerate()))")
    out = subprocess.run([sys.executable, "-c", probe], cwd=ROOT, env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().splitlines()[-1] == "['MainThread']"


def test_the_first_request_starts_the_boot_work_once(starts):
    c = server.app.test_client()
    c.get("/__boot_probe")
    assert starts == BOOT
    c.get("/__boot_probe")
    assert starts == BOOT


def test_concurrent_first_requests_start_it_once(starts):
    gate = threading.Barrier(4)

    def first():
        gate.wait(5)
        server.app.test_client().get("/__boot_probe")
    readers = [threading.Thread(target=first) for _ in range(4)]
    for t in readers:
        t.start()
    for t in readers:
        t.join(10)
    assert starts == BOOT


def test_a_failed_start_neither_fails_the_request_nor_stops_the_rest(starts, monkeypatch):
    def broken():
        raise RuntimeError("store unreachable")
    monkeypatch.setattr(server, "_start_retention_sweep", broken)
    r = server.app.test_client().get("/__boot_probe")
    assert r.status_code == 404                     # the request itself, untouched
    assert starts == ["_maybe_warm_pool", "_maybe_warm_covers"]


def test_apps_built_by_create_app_start_none_of_it(starts, client):
    client.get("/__boot_probe")
    assert starts == [] and server._boot_started is False
