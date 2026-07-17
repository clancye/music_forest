import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const J = require(process.env.JS_DIR ? process.env.JS_DIR + "/journal-store.js" : "../../static/journal-store.js");
const d = JSON.parse(readFileSync((process.env.PARITY_JSON || "/tmp/parity.json"), "utf8"));
const notes = d.notes_input, choices = d.choices_input, exp = d.expected;

const got = {
  subjects: J.subjects(notes, 2, 40),
  subject_graph: J.subjectGraph(notes, 2, 40),
  choices_stats: J.choicesStats(choices),
  feed_all: J.feed(notes).notes,
  feed_grief: J.feed(notes, "grief").notes,
  feed_nigel: J.feed(notes, "nigel").notes,
  counts: J.counts(notes),
};

let fails = 0;
function cmp(name, a, b) {
  // Normalize: feed notes from python carry extra keys; compare on shared shape via JSON of selected fields.
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) { console.log("  ✓", name); }
  else { fails++; console.log("  ✗", name); console.log("    python:", B.slice(0,300)); console.log("    js    :", A.slice(0,300)); }
}

cmp("subjects", got.subjects, exp.subjects);
cmp("choices_stats", got.choices_stats, exp.choices_stats);
cmp("counts", got.counts, exp.counts);

// feed: compare on (id, body) order
const normFeed = s => s.map(n => ({id:n.id, body:n.body, artist:n.artist}));
cmp("feed_all(order)", normFeed(got.feed_all), normFeed(exp.feed_all));
cmp("feed_grief(order)", normFeed(got.feed_grief), normFeed(exp.feed_grief));
cmp("feed_nigel(ref-label)", normFeed(got.feed_nigel), normFeed(exp.feed_nigel));

// subject_graph: compare subjects list (term,count,trails,note_ids) and notes_total
const normSG = g => ({subjects: g.subjects, notes_total: g.notes_total, min_notes: g.min_notes,
                      note_keys: Object.keys(g.notes).map(String).sort()});
cmp("subject_graph", normSG(got.subject_graph), normSG(exp.subject_graph));

console.log(fails ? `\n${fails} MISMATCH` : "\nALL ANALYTICS MATCH journal.py");
process.exit(fails?1:0);
