"""Write a Vietnamese/English-only copy of sea-g2p's phoneme dictionary.

    .venv/bin/python scripts/strip_dict.py IN.bin OUT.bin

sea_g2p.bin (SEAP v2, see vendor/sea-g2p/src/core/dict.rs) holds the Vietnamese
and English tables (`merged`, `common`) plus language sections for Thai (3),
Thai word frequencies (4) and Indonesian (5). The browser build only speaks
Vietnamese, so this keeps the two Latin tables, drops every section, and
rebuilds the string pool so strings used only by the dropped sections go too.

The output is still v2 (with zero sections), so the Rust loader needs no change.
"""
import struct
import sys
from pathlib import Path

HEADER_V2 = 48
SECTION_NAMES = {3: "Thai", 4: "Thai frequencies", 5: "Indonesian"}


def load(data: bytes):
    assert data[:4] == b"SEAP", "not a SEAP dictionary"
    version = struct.unpack_from("<I", data, 4)[0]
    assert version == 2, f"expected SEAP v2, got v{version}"
    sc, mc, cc = struct.unpack_from("<III", data, 8)
    sop, mp, cp = struct.unpack_from("<III", data, 20)
    n_sections, sections_pos = struct.unpack_from("<II", data, 32)

    def s(sid):
        start = HEADER_V2 + struct.unpack_from("<I", data, sop + sid * 4)[0]
        return data[start:data.index(b"\x00", start)].decode("utf-8")

    merged = [(s(w), s(p)) for w, p in (struct.unpack_from("<II", data, mp + i * 8) for i in range(mc))]
    common = [(s(w), s(v), s(e)) for w, v, e in (struct.unpack_from("<III", data, cp + i * 12) for i in range(cc))]
    sections = [struct.unpack_from("<III", data, sections_pos + i * 12) for i in range(n_sections)]
    return merged, common, sections, sc


def write(merged, common) -> bytes:
    """Same layout as vendor/sea-g2p/scripts/seap.py write_bin_v2, with no sections.
    Rows keep their input order, which is already sorted by UTF-8 bytes."""
    ids: dict[str, int] = {}

    def sid(x):
        return ids.setdefault(x, len(ids))

    merged_rows = [(sid(w), sid(p)) for w, p in merged]
    common_rows = [(sid(w), sid(v), sid(e)) for w, v, e in common]
    blob, offsets = bytearray(), []
    for x in ids:
        offsets.append(len(blob))
        blob += x.encode("utf-8") + b"\x00"
    sop = HEADER_V2 + len(blob)
    mp = sop + 4 * len(offsets)
    cp = mp + 8 * len(merged_rows)
    sections_pos = cp + 12 * len(common_rows)

    out = bytearray(b"SEAP" + struct.pack("<I", 2))
    out += struct.pack("<III", len(ids), len(merged_rows), len(common_rows))
    out += struct.pack("<III", sop, mp, cp)
    out += struct.pack("<II", 0, sections_pos)
    out += b"\x00" * 8
    out += blob
    out += b"".join(struct.pack("<I", o) for o in offsets)
    out += b"".join(struct.pack("<II", *r) for r in merged_rows)
    out += b"".join(struct.pack("<III", *r) for r in common_rows)
    return bytes(out)


def main(src: str, dst: str) -> None:
    data = Path(src).read_bytes()
    merged, common, sections, n_strings = load(data)
    for kind, count, _ in sections:
        print(f"  dropping section {kind} ({SECTION_NAMES.get(kind, '?')}): {count:,} entries")
    keys = [r[0].encode("utf-8") for r in merged]
    assert keys == sorted(keys), "merged table is not sorted"
    out = write(merged, common)
    Path(dst).write_bytes(out)
    print(f"{src}: {len(data) / 1e6:.1f} MB, {n_strings:,} strings")
    print(f"{dst}: {len(out) / 1e6:.1f} MB, {len(merged):,} merged + {len(common):,} common entries")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
