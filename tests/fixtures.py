"""
A tiny, hand-written Discogs-style releases dump for the test suite (R1).

Kept as text (not a committed binary) so it's reviewable and easy to extend.
``write_dump()`` gzips it to a path so build_db can parse it exactly like the
real ~11 GB dump. The set of releases is chosen to exercise every interesting
branch of the parser:

  * 100 & 101 share master 50 -> canonical collapses to the earliest (100).
  * 102 is standalone (no master) with a <join> connector + a "(2)" suffix.
  * 103 has a 00-00 partial date -> excluded.
  * 104 is standalone with a tracklist that includes a heading row to skip,
    and an <identifiers> block carrying a Barcode (Text + String dupes that must
    collapse to one normalized GTIN-14) plus a non-Barcode identifier to ignore.
  * 105 has no <released> at all -> excluded.

Credits (F27) woven through the same releases:

  * 100 carries a linked credit (person 900, "Producer Pam (2)") plus an
    UNLINKED one (id 0 -> plain text, never a door).
  * 101 (the non-canonical reissue) credits person 901 -> their door must still
    surface the album via its canonical pressing 100.
  * 103 (excluded date) carries a credit that must NOT be ingested.
  * 104 credits person 900 again under a different name spelling and role, so
    the display name and per-album role quoting are exercised.
"""
import gzip

DUMP_XML = """<?xml version="1.0" encoding="UTF-8"?>
<releases>
<release id="100" status="Accepted">
  <master_id is_main_release="true">50</master_id>
  <title>First Pressing</title>
  <country>UK</country>
  <released>1985-03-10</released>
  <artists><artist><id>1</id><name>Alpha</name></artist></artists>
  <genres><genre>Electronic</genre><genre>Rock</genre></genres>
  <styles><style>Synth-pop</style></styles>
  <formats><format name="Vinyl" qty="1"><descriptions><description>LP</description><description>Album</description></descriptions></format></formats>
  <labels><label name="Acme Records" catno="ACME-1"/></labels>
  <extraartists>
    <artist><id>900</id><name>Producer Pam (2)</name><role>Producer</role></artist>
    <artist><id>0</id><name>Uncredited Ursula</name><role>Photography By</role></artist>
  </extraartists>
</release>
<release id="101" status="Accepted">
  <master_id is_main_release="false">50</master_id>
  <title>First Pressing (Reissue)</title>
  <country>US</country>
  <released>1990-03-10</released>
  <artists><artist><id>1</id><name>Alpha</name></artist></artists>
  <genres><genre>Electronic</genre></genres>
  <extraartists>
    <artist><id>901</id><name>Remaster Rhea</name><role>Remastered By</role></artist>
  </extraartists>
</release>
<release id="102" status="Accepted">
  <master_id is_main_release="false">0</master_id>
  <title>Standalone One</title>
  <country>UK</country>
  <released>1985-03-10</released>
  <artists>
    <artist><id>2</id><name>Beta (2)</name><join>feat.</join></artist>
    <artist><id>3</id><name>Gamma</name></artist>
  </artists>
  <genres><genre>Folk, World, &amp; Country</genre></genres>
</release>
<release id="103" status="Accepted">
  <title>Unknown Day</title>
  <released>1969-00-00</released>
  <artists><artist><id>4</id><name>Delta</name></artist></artists>
  <extraartists>
    <artist><id>900</id><name>Producer Pam (2)</name><role>Producer</role></artist>
  </extraartists>
</release>
<release id="104" status="Accepted">
  <title>Tracky</title>
  <country>DE</country>
  <released>2000-12-01</released>
  <artists><artist><id>5</id><name>Epsilon</name></artist></artists>
  <genres><genre>Jazz</genre></genres>
  <tracklist>
    <track><position></position><title>Side A</title><duration></duration></track>
    <track><position>A1</position><title>Opener</title><duration>3:21</duration></track>
    <track><position>A2</position><title>Closer</title><duration>4:05</duration></track>
  </tracklist>
  <identifiers>
    <identifier type="Barcode" description="Text" value="0 7464-63628-2 2"/>
    <identifier type="Barcode" description="String" value="074646362822"/>
    <identifier type="Matrix / Runout" description="" value="CPDP-098103 G4 1A 01"/>
  </identifiers>
  <extraartists>
    <artist><id>900</id><name>Producer Pam</name><role>Mixed By</role></artist>
  </extraartists>
</release>
<release id="105" status="Accepted">
  <title>No Date</title>
  <artists><artist><id>6</id><name>Zeta</name></artist></artists>
</release>
</releases>
"""


def write_dump(path):
    """Gzip the fixture XML to *path* and return it (as a str)."""
    with gzip.open(path, "wb") as fh:
        fh.write(DUMP_XML.encode("utf-8"))
    return str(path)
