#!/usr/bin/env bash
# Run the headless JS tests for the H1.2 client crypto layer.
#
# These cover what can be tested without a browser: the AES-GCM envelope
# (crypto.js), the authed transport contract (sync.js), the encrypt->reload->
# decrypt store engine (journal-store.js), and byte-for-byte parity of the
# analytics port against journal.py. The Argon2id WASM and the full UI flow are
# covered by the in-browser checklist (SMOKE_TEST_H1_2.md).
#
# Requires: node (>=18, for global WebCrypto) and python3 (for the parity fixture).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

echo "== css-escape (S6) =="     ; node css-escape.test.mjs
echo "== crypto.js =="          ; node crypto.test.mjs
echo "== crypto.js KDF invariant (recovery-safety) ==" ; node crypto-kdf.test.mjs
echo "== sync.js =="            ; node sync.test.mjs
echo "== feedback-sync.js =="   ; node feedback-sync.test.mjs
echo "== journal-store.js =="   ; node store.test.mjs
echo "== journal-store uid re-key (P3 M2) ==" ; node store-uid.test.mjs
echo "== journal-store write-gate (P4 signed-in reveal) ==" ; node store-ready-gate.test.mjs
echo "== guest-buffer.js =="     ; node guest-buffer.test.mjs
echo "== guest-migrate.js =="    ; node guest-migrate.test.mjs
echo "== onboarding.js =="       ; node onboarding.test.mjs
echo "== auth-ui.js error classification (invite gate vs expired link) ==" ; node auth-error-classify.test.mjs
echo "== sw.js navigation (5xx -> cached shell) ==" ; node sw-navigation.test.mjs
echo "== strings.js (R8) =="      ; node strings.test.mjs
echo "== pick-listen priority selection ==" ; node pick-listen.test.mjs
echo "== balanced-order (A8 genre-balanced deal) ==" ; node balanced-order.test.mjs
echo "== deal-order (B25 compilations dealt later) ==" ; node deal-order.test.mjs
echo "== resume-at (keep your place across a reload) ==" ; node resume-at.test.mjs
echo "== human-duration (invite accept latency) ==" ; node human-duration.test.mjs
echo "== whatsnew (changes since your last update) ==" ; node whatsnew.test.mjs
echo "== keep-retry (a keep survives a brief outage) ==" ; node keep-retry.test.mjs
echo "== genre-filter (A8 Phase 2 client filter) ==" ; node genre-filter.test.mjs
echo "== analytics parity vs journal.py =="
python3 "$ROOT/tests/js/parity_gen.py" > /tmp/aotd_parity.json
PARITY_JSON=/tmp/aotd_parity.json node parity_check.mjs
if [ -f "$ROOT/tools/restore_drill.mjs" ]; then
  echo "== restore drill (self-test) ==" ; node "$ROOT/tools/restore_drill.mjs" --self-test
fi
echo
echo "All headless JS tests passed."
