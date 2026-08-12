#!/usr/bin/env bash
# Run the FULL standard suite inside the Cowork/Linux sandbox.
#
# The owner runs the real suite natively on macOS; this script only exists so the
# in-sandbox agent can self-verify. The repo's `.venv` is the Mac venv (arm64,
# python3.14) and the sandbox has no network to pip-install anything — but Flask,
# pytest and friends are PURE PYTHON, so we point the sandbox interpreter at that
# venv's site-packages. Two gaps are bridged: (1) `exceptiongroup`, a py<3.11
# backport the Mac's 3.14 doesn't ship, is generated as a tiny shim; (2) the C
# extensions `lxml` and `Pillow` are taken from the sandbox's own system install
# instead of the Mac binaries. Everything lives in a throwaway temp dir; the repo
# is left untouched.
#
# Usage:  bash tests/sandbox_suite.sh          # from the repo root
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SP="$(ls -d "$ROOT"/.venv/lib/python3.*/site-packages 2>/dev/null | head -1)"
if [ -z "$SP" ] || [ ! -d "$SP/flask" ]; then
  echo "FATAL: no Mac .venv site-packages with Flask found at .venv/lib/python3.*/site-packages" >&2
  echo "       (this script is for the sandbox only; run the suite natively on the Mac)" >&2
  exit 2
fi

SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT

cat > "$SHIM/exceptiongroup.py" <<'PY'
# Minimal PEP-654 backport so pytest imports under sandbox python<3.11.
# The Mac's python3.14 has these builtin and never touches this file.
import sys
if sys.version_info >= (3, 11):
    BaseExceptionGroup = BaseExceptionGroup
    ExceptionGroup = ExceptionGroup
else:
    class BaseExceptionGroup(BaseException):
        def __class_getitem__(cls, item): return cls
        def __new__(cls, message, exceptions):
            if cls is BaseExceptionGroup and all(isinstance(e, Exception) for e in exceptions):
                cls = ExceptionGroup
            return super().__new__(cls, message, exceptions)
        def __init__(self, message, exceptions):
            self._message, self._exceptions = message, tuple(exceptions)
            super().__init__(message, exceptions)
        @property
        def message(self): return self._message
        @property
        def exceptions(self): return self._exceptions
        def derive(self, excs): return BaseExceptionGroup(self._message, excs)
        def subgroup(self, cond):
            m = [e for e in self._exceptions if (isinstance(e, cond) if isinstance(cond, type) else cond(e))]
            return self.derive(m) if m else None
        def split(self, cond):
            a, b = [], []
            for e in self._exceptions:
                (a if (isinstance(e, cond) if isinstance(cond, type) else cond(e)) else b).append(e)
            return (self.derive(a) if a else None, self.derive(b) if b else None)
        def __str__(self):
            n = len(self._exceptions)
            return f"{self._message} ({n} sub-exception{'s' if n != 1 else ''})"
    class ExceptionGroup(BaseExceptionGroup, Exception):
        def derive(self, excs): return ExceptionGroup(self._message, excs)
__all__ = ["BaseExceptionGroup", "ExceptionGroup"]
PY

for mod in lxml PIL; do
  d="$(python3 - "$mod" <<'PY'
import sys, os, importlib
sys.path = [p for p in sys.path if "python3.14" not in p]
try:
    m = importlib.import_module(sys.argv[1])
    print(os.path.dirname(m.__file__))
except Exception:
    print("")
PY
)"
  if [ -n "$d" ]; then ln -sf "$d" "$SHIM/$mod"; else
    echo "WARN: sandbox system '$mod' not found; the few tests needing it may error" >&2
  fi
done

export PYTHONPATH="$SHIM:$SP"
rc=0
echo "=== py_compile ==="
python3 -m py_compile db.py pooldb.py server.py config.py tools/*.py && echo "  compile OK" || rc=1
echo "=== node --check static/app.js ==="
node --check static/app.js && echo "  node OK" || rc=1
echo "=== python test_pooldb.py ==="
python3 test_pooldb.py >/tmp/aotd_pooldb.log 2>&1 && tail -1 /tmp/aotd_pooldb.log || { rc=1; tail -25 /tmp/aotd_pooldb.log; }
echo "=== pytest tests/ ==="
python3 -m pytest tests/ -q >/tmp/aotd_pytest.log 2>&1 && tail -1 /tmp/aotd_pytest.log || { rc=1; tail -40 /tmp/aotd_pytest.log; }
echo "=== bash tests/js/run.sh ==="
bash tests/js/run.sh >/tmp/aotd_js.log 2>&1 && tail -1 /tmp/aotd_js.log || { rc=1; tail -40 /tmp/aotd_js.log; }
echo "=== RESULT rc=$rc ==="
exit $rc
