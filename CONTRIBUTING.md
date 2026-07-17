# Contributing to Music Forest

Thanks for your interest. Small, focused improvements and thoughtful bug reports are
genuinely welcome. This guide covers the one thing to know first, how to get set up, and
the house style.

## Before you build: the one thing to know

Music Forest holds a firm line on what it *won't* be — no recommendation engine, no
notifications that pull you back, no gamification, no automatic resurfacing of people or
memories. Some clever ideas are declined on purpose — not for lack of quality, but because
they'd pull the app away from that line. When in doubt, open an issue before you build.

- **Bug fixes and small, obvious improvements** — just open a pull request.
- **Anything larger, or anything that changes behavior or scope** — open an issue first so
  we can talk about whether it fits. This saves you from building something that can't be
  merged for reasons of principle rather than quality.

## Getting set up

```
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pytest -q          # runs against a tiny fixture catalog built on the fly
python server.py   # local single-user mode: auth + encryption are bypassed for dev
```

The production album catalog and the crawl pipeline aren't in this repo (see the
[README](README.md)), so a few data-dependent tests won't run locally — that's expected.
The checks below are the ones every change should pass.

## The checks every change should pass

```
pytest tests/ -q             # the app test suite (fixture DB, no network)
bash tests/js/run.sh         # headless client tests (crypto / store / sync)
python -m py_compile *.py     # server + modules compile
node --check static/app.js   # client parses
```

If you touch the **encryption or sync path**, the headless JS suite is the one to watch —
it exercises the full create → encrypt → recover → decrypt cycle. A change there without a
passing crypto test won't be merged.

## House style

- **No build step.** The client in [`static/`](static/) is plain JavaScript, one
  stylesheet, and a service worker — no framework, no bundler. Please keep it that way;
  it's a feature, not a limitation.
- **Version bump for client changes.** If you change any PWA-shell asset (`static/app.js`,
  `static/style.css`, `static/index.html`, `static/sw.js`), bump **both** `VERSION` in
  `static/sw.js` and `window.__MF_BUILD` in `static/app.js` together — they track each
  other, and the service worker uses the version to ship a fresh shell to everyone.
- **Words matter.** The daily act is **keeping**: records come one at a time, and you
  **keep** the ones that stay with you or **set the rest aside**. Use *keep / set aside* in
  UI copy and comments — never *pick / winner / loser*, and never frame the day as a contest
  or a choice between two records. (The store layer still uses legacy `choices` / `chosen_*`
  keys under the hood; leave those as they are, but never surface them in user-facing copy.)
  An un-checked album is **unknown**, never "unavailable."
- **Tests.** App tests live in [`tests/`](tests/); name a new test to match what it covers.
  If you fix a bug, add the test that would have caught it.
- **Commits.** One focused change per commit, with a message that says what and why. Match
  the style of the code around you rather than introducing a new one.

## Security issues

Please **don't** report security vulnerabilities in public issues — see
[SECURITY.md](SECURITY.md) for private reporting. Security, and specifically the "we can't
read your field notebook" guarantee, is the core of the project.

## Licensing of contributions

Music Forest is licensed under **AGPL-3.0**. By submitting a contribution you agree it is
provided under that same license (inbound = outbound). Please only contribute code you have
the right to license this way.

## Being a good neighbor

Be kind and assume good faith. This is a small, calm project — the quiet, unhurried tone the
app aims for is the one we aim for here, too.
