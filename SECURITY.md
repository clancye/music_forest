# Security Policy

Music Forest keeps a private, end-to-end-encrypted field notebook for each person who uses it.
Security — and specifically the guarantee that **we cannot read your field notebook** — is the
core promise of the project, so security reports are taken seriously and welcomed.

## Reporting a vulnerability

**Please report privately. Do not open a public GitHub issue for a security bug.**

Email **info@musicforest.lol** with:

- what you found and where (a file, an endpoint, a request/response),
- how to reproduce it, and
- what an attacker could do with it.

You'll get an acknowledgement as soon as we can — this is a small project, so please allow
a few days. We practice **coordinated disclosure**: we'll work with you on a fix and a
timeline, and we ask that you give us a reasonable window to ship it before disclosing
publicly. We're glad to credit you (or keep you anonymous — your choice).

There is no paid bug-bounty program. What we can offer is a prompt, honest response and
public thanks.

## What we care about most

The design intends that **the server only ever holds ciphertext**. Reports that undermine
that are the highest priority. In scope, roughly in order:

- **The encryption / sync path** — anything that would let the server, an operator, a
  sub-processor, or a network attacker read, forge, or silently corrupt field-notebook contents;
  weaknesses in key derivation, key wrapping, the recovery-code flow, or the encrypted
  sync payload.
- **Authentication** — token verification, session handling, or any way to act as another
  user or reach another user's rows.
- **The web client** — cross-site scripting or a Content-Security-Policy bypass. XSS is the
  most serious threat to in-browser encryption, so the CSP is strict by design; a way
  around it is a real finding.
- **The server API** — injection, path traversal, authorization gaps, or leakage of data
  the app is supposed to keep private (including in logs).

### Where to look

- [`static/crypto.js`](static/crypto.js) — Argon2id key derivation, AES-GCM, key wrapping.
- [`static/journal-store.js`](static/journal-store.js), [`static/sync.js`](static/sync.js)
  — what is encrypted and the shape of the sync payload.
- [`auth.py`](auth.py) — JWT verification (algorithm is pinned; no `alg:none` downgrade).
- [`server.py`](server.py) — `build_csp()` and `security_headers()`.

## How do I know the running code matches this repo?

The client that encrypts your notebook runs in your browser, and it is served
**unminified and same-origin** — the `static/crypto.js`, `static/sync.js`, and
`static/app.js` executing in your browser are the source files in this repository,
not a bundled or minified blob. Open your browser's developer tools, read exactly
what is running, and compare it against this repo. If the two ever differed, anyone
could see it.

For a stronger check, this repository ships an [`INTEGRITY.sha256`](INTEGRITY.sha256)
manifest: a SHA-256 hash of every client asset as published. Fetch the same files
from musicforest.lol and compare the hashes — when they match, the running client is
byte-for-byte the code you are reading here, and you did not have to take our word
for it.

The server is intentionally untrusted. End-to-end encryption means it only ever holds
ciphertext and never your key, so the privacy guarantee does not depend on trusting
our deployment — it depends on the encryption, which you can read here. The live site
at musicforest.lol is deployed from a private repository that adds the catalog data
pipeline and operational tooling on top of this exact application code; none of that
touches your notebook or the encryption path.

## Out of scope

- Vulnerabilities in third-party services we build on (Supabase, Render, the CDN, the music
  platforms we link out to) — report those to the respective vendor.
- Attacks that require a device already compromised, or knowledge of the user's passphrase
  or recovery code.
- Volumetric denial-of-service against the hosted instance.
- Missing "best practice" headers with no demonstrable impact, and reports produced only by
  an automated scanner with no working proof of concept.

## A note on recovery, by design

Your field notebook is unlocked by a passphrase (and optionally an opt-in device unlock); a
one-time **recovery code** shown at signup is the reset path if you forget it. The server
stores only *wrapped* keys it cannot open. This means that **if you lose both your
passphrase and your recovery code, your field notebook cannot be recovered — by you or by us.**
That is an intentional property of end-to-end encryption, not a vulnerability.

## Supported versions

Music Forest is continuously deployed. The version running at
[musicforest.lol](https://musicforest.lol) and the current `main` branch are what we
support; there are no separate maintained release branches.
