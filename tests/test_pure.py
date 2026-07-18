"""Pure-function unit tests: no database, no network (R1)."""
import xml.etree.ElementTree as ET

import build_db
import db as dbmod
from genres import split_genres


def _release(xml):
    return ET.fromstring(xml)


# --- parse_date -------------------------------------------------------------

def test_parse_date_full():
    assert build_db.parse_date("1985-03-10") == (1985, 3, 10)


def test_parse_date_rejects_zero_month_day():
    assert build_db.parse_date("1969-00-00") is None
    assert build_db.parse_date("1969-05-00") is None


def test_parse_date_rejects_out_of_range_and_garbage():
    assert build_db.parse_date("1985-13-10") is None
    assert build_db.parse_date("1985-03-40") is None
    assert build_db.parse_date("1985") is None
    assert build_db.parse_date("") is None
    assert build_db.parse_date(None) is None


# --- collect_artists --------------------------------------------------------

def test_collect_artists_join_and_disambiguation():
    rel = _release(
        "<release><artists>"
        "<artist><name>Beta (2)</name><join>feat.</join></artist>"
        "<artist><name>Gamma</name></artist>"
        "</artists></release>")
    assert build_db.collect_artists(rel) == "Beta feat. Gamma"


def test_collect_artists_comma_list():
    rel = _release(
        "<release><artists>"
        "<artist><name>A</name><join>,</join></artist>"
        "<artist><name>B</name></artist>"
        "</artists></release>")
    assert build_db.collect_artists(rel) == "A, B"


def test_collect_artists_none_when_missing():
    assert build_db.collect_artists(_release("<release/>")) is None


# --- collect_tracks ---------------------------------------------------------

def test_collect_tracks_skips_headings():
    rel = _release(
        "<release><tracklist>"
        "<track><position></position><title>Side A</title><duration></duration></track>"
        "<track><position>A1</position><title>Opener</title><duration>3:21</duration></track>"
        "</tracklist></release>")
    tracks = build_db.collect_tracks(rel)
    assert tracks == [{"pos": "A1", "title": "Opener", "dur": "3:21"}]


def test_collect_tracks_none_when_empty():
    assert build_db.collect_tracks(_release("<release/>")) is None


# --- collect_formats --------------------------------------------------------

def test_collect_formats_with_descriptions():
    rel = _release(
        '<release><formats><format name="Vinyl">'
        "<descriptions><description>LP</description>"
        "<description>Album</description></descriptions>"
        "</format></formats></release>")
    assert build_db.collect_formats(rel) == "Vinyl (LP, Album)"


# --- norm_barcode / collect_barcodes ----------------------------------------

def test_norm_barcode_upca_and_ean13_collapse():
    # UPC-A (12) and its EAN-13 (13 = leading-0 + UPC-A) must map to one GTIN-14.
    assert build_db.norm_barcode("074646362822") == "00074646362822"
    assert build_db.norm_barcode("0074646362822") == "00074646362822"
    # spaced / dashed "Text" form normalizes to the same key
    assert build_db.norm_barcode("0 7464-63628-2 2") == "00074646362822"


def test_norm_barcode_rejects_non_gtin_lengths():
    assert build_db.norm_barcode("12345") is None          # runout-ish short
    assert build_db.norm_barcode("123456789012345") is None  # too long
    assert build_db.norm_barcode("") is None
    assert build_db.norm_barcode(None) is None


def test_collect_barcodes_filters_type_and_dedups():
    rel = _release(
        '<release><identifiers>'
        '<identifier type="Barcode" description="Text" value="0 7464-63628-2 2"/>'
        '<identifier type="Barcode" description="String" value="074646362822"/>'
        '<identifier type="Matrix / Runout" value="CPDP-098103 G4 1A 01"/>'
        '</identifiers></release>')
    import json
    assert json.loads(build_db.collect_barcodes(rel)) == ["00074646362822"]


def test_collect_barcodes_keeps_distinct_multiple():
    rel = _release(
        '<release><identifiers>'
        '<identifier type="Barcode" value="074646362822"/>'
        '<identifier type="Barcode" value="5051234567890"/>'
        '</identifiers></release>')
    import json
    assert json.loads(build_db.collect_barcodes(rel)) == [
        "00074646362822", "05051234567890"]


def test_collect_barcodes_none_when_absent_or_junk():
    assert build_db.collect_barcodes(_release("<release/>")) is None
    rel = _release(
        '<release><identifiers>'
        '<identifier type="Matrix / Runout" value="ABC123"/>'
        '</identifiers></release>')
    assert build_db.collect_barcodes(rel) is None


# --- genres.split_genres ----------------------------------------------------

def test_split_genres_keeps_atomic_comma_genre():
    assert split_genres("Rock, Folk, World, & Country, Jazz") == [
        "Rock", "Folk, World, & Country", "Jazz"]


def test_split_genres_empty():
    assert split_genres("") == []
    assert split_genres(None) == []


# --- db._fts_query ----------------------------------------------------------

def test_fts_query_prefixes_and_ands():
    assert dbmod._fts_query("mile dav") == "mile* dav*"


def test_fts_query_field_scoping():
    assert dbmod._fts_query("mile dav", field="artist") == \
        "artist:mile* artist:dav*"


def test_fts_query_strips_operators():
    # stray quotes/operators must not leak into MATCH syntax
    assert dbmod._fts_query('"miles" OR (davis)') == "miles* or* davis*"


def test_fts_query_empty():
    assert dbmod._fts_query("   ") is None
    assert dbmod._fts_query("!!!") is None


# B26: a 1-char token is matched exactly, not as a prefix — `a*` constrains
# nothing but makes bm25 score ~1/6 of the index ("a tribe called quest" was
# 526 ms; 6 ms now). 2+ chars is a real narrowing and keeps its prefix.

def test_fts_query_single_char_token_is_exact():
    assert dbmod._fts_query("a") == "a"
    assert dbmod._fts_query("a tribe called quest") == "a tribe* called* quest*"


def test_fts_query_two_char_token_keeps_its_prefix():
    assert dbmod._fts_query("u2") == "u2*"
    assert dbmod._fts_query("ra") == "ra*"


def test_fts_query_single_char_still_field_scoped():
    assert dbmod._fts_query("a tribe", field="artist") == \
        "artist:a artist:tribe*"
