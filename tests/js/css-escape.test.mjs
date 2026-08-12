/*
 * S6: the cssUrl() helper must neutralize a single-quoted CSS url('…') context,
 * not just HTML. app.js is browser code (touches `document` at load), so rather
 * than import it we lift the `esc` and `cssUrl` definitions out of the source and
 * eval them in isolation — this also proves the helpers as actually shipped.
 *
 * Run: node tests/js/css-escape.test.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "static", "app.js"), "utf8");

// Pull the two arrow-const definitions verbatim from app.js.
function lift(name) {
  const re = new RegExp(`const ${name} = [\\s\\S]*?\\}\\[c\\]\\)\\);`);
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in app.js`);
  return m[0];
}
const code = `${lift("esc")}\n${lift("cssUrl")}\nreturn { esc, cssUrl };`;
// eslint-disable-next-line no-new-func
const { esc, cssUrl } = new Function(code)();

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; } else { failed++; console.error("  ✗ FAIL:", m); } }

// A clean URL is untouched.
ok(cssUrl("/static/art/123.jpg") === "/static/art/123.jpg", "clean path unchanged");
ok(cssUrl("https://is1-ssl.mzstatic.com/a/600x600bb.jpg")
   === "https://is1-ssl.mzstatic.com/a/600x600bb.jpg", "clean https url unchanged");

// The attack: close the url(), end the declaration, inject more CSS.
const evil = "x'); background:url('javascript:alert(1)";
const out = cssUrl(evil);
ok(!out.includes("'"), "no raw single-quote survives");
ok(!out.includes("("), "no raw open-paren survives");
ok(!out.includes(")"), "no raw close-paren survives");
ok(out.includes("%27") && out.includes("%28") && out.includes("%29"),
   "quote/parens percent-encoded");

// Newlines (which could also break out) and backslashes are encoded.
ok(cssUrl("a\nb") === "a%0Ab", "newline encoded");
ok(cssUrl("a\\b") === "a%5Cb", "backslash encoded");

// HTML metachars still handled (cssUrl composes esc).
ok(!cssUrl('a"b').includes('"'), "double-quote still escaped via esc");
ok(cssUrl("a<b").includes("&lt;"), "angle bracket still escaped via esc");

// null/undefined are safe.
ok(cssUrl(null) === "", "null -> empty");
ok(cssUrl(undefined) === "", "undefined -> empty");

console.log(`css-escape: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
