# Music Forest

**Find music, write notes.**

Records released on *this date*, any year — met one at a time. You keep the ones that
stay with you and write down what you notice — encrypted on your device, so it's yours alone.

It's a personal field notebook for your listening life. It helps you connect a record to
your own life and offers threads you can pull about the wider human story behind the music:
the scene it came from, the people who made it. It is **not** a social network: it connects
the music to your world, not you to other users. No profiles, no followers, no feed. And it
is **not** a recommender, an ad product, or an engagement machine — no infinite feed, no
autoplay, no algorithm deciding what you should hear next. The reward is what *you* put in.

The hosted version lives at **[musicforest.lol](https://musicforest.lol)**.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-8fae72.svg)](https://www.gnu.org/licenses/agpl-3.0)

---

## Why this is open

Music Forest's core claim is that **your field notebook is readable by you and no one else.** Your
notes are encrypted on your device before they reach the server, which only ever stores
ciphertext it can't read.

The client is open so you can check that yourself instead of taking our word for it. To see
how the encryption works, start here:

- [`static/crypto.js`](static/crypto.js) — key derivation (Argon2id), encryption
  (AES-GCM), and how keys are wrapped by your passphrase and recovery code.
- [`static/journal-store.js`](static/journal-store.js) / [`static/sync.js`](static/sync.js)
  — what gets encrypted and what the sync payload looks like on the wire.
- [`auth.py`](auth.py) — how the server verifies who you are (it never sees your key).
- [`server.py`](server.py) — the Content-Security-Policy and security headers
  (`build_csp` / `security_headers`).

If you find a place where the code doesn't back that up, please tell us — see
[SECURITY.md](SECURITY.md).

## What it is, briefly

Music Forest brings you the records released on the current calendar date (in any year) from
a large catalog, one at a time, and invites a small act: **keep the ones that stay with you.**
Then you write down what you notice about a record — a line, a memory, whatever it
stirs — and over time your notebook fills with your own words. Every outward link (to a
streaming service, an artist, the story behind a
record) is a **door**: it opens, and it closes you back exactly where you were. Never a
corridor that carries you off.

The design line is simple: features earn their place by deepening the ritual, not by adding
surface — pull, not push; a door, never a corridor.

## Architecture

A small, sturdy stack, chosen for reliability over novelty:

- **Backend** — a [Flask](https://flask.palletsprojects.com/) app (`server.py`) serving a
  JSON API and the static client, behind gunicorn. The album catalog is a **read-only
  SQLite** file; per-user encrypted field-notebook state syncs to Postgres (Supabase).
- **Client** — a **no-build** static Progressive Web App in [`static/`](static/):
  plain JavaScript, one stylesheet, a service worker. No framework, no bundler.
- **Encryption** — done in the browser with vetted primitives (libsodium / WebCrypto).
  The server is a blind sync layer; it cannot decrypt anything.
- **Hosting** — one web service (the app + API + read-only catalog), same-origin, with
  encrypted rows in a managed Postgres.

A guided tour of how it fits together is at
**[musicforest.lol/architecture](https://musicforest.lol/architecture)**.

## What's in this repository — and what isn't

This repo is the **application**: the client, the server, and the tests.

It does **not** include the album **catalog data** or the crawl/ingest **pipeline** that
builds it. The catalog is derived from third-party sources (the Discogs data dump,
MusicBrainz, the Cover Art Archive, Apple) under their own licenses, and is far too large
to distribute here; the pipeline that assembles and warms it is operational tooling kept
separate. So this repository is primarily for **reading, auditing, and contributing** — not
a turnkey self-host.

For development, the test suite builds a tiny fixture catalog on the fly, so you can run
the app locally in single-user mode without any of the production data:

```
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest -q                 # app tests, against a throwaway fixture DB
python server.py          # local single-user mode (auth + encryption bypassed for dev)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full test suite and house style.

## Contributing

Small, focused pull requests and thoughtful issues are welcome. One thing to know before
you build: Music Forest holds a firm line on what it *won't* be (no recommendation engine,
no notifications that pull you back, no gamification, no automatic resurfacing of people or
memories). Some clever ideas are declined on purpose. If you're unsure whether something
fits, open an issue first and let's talk.

## License

Music Forest is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0) —
see [LICENSE](LICENSE). In short: you're free to use, study, modify, and share it, and if
you run a modified version **as a network service**, you must offer your users the source
of your changes under the same license. The hosted service at musicforest.lol is offered
under these terms.

Copyright © 2026 Clancy Emanuel.

The AGPL covers the **code**. It does not grant rights to the **"Music Forest" name, the
wordmark, or the two-fir logo** — please don't use the brand in a way that implies your
fork is the official Music Forest. Album metadata and cover art belong to their respective
sources (Discogs, MusicBrainz, the Cover Art Archive, Apple) under their own terms.

Music Forest is not affiliated with, endorsed by, or sponsored by any of the streaming
services it links out to.
