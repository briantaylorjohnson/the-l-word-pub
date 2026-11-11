"""
Extract the reference-data tabs that already live fully inside the original
"Combat Log Analytics" workbook into seed JSON matching the Amplify Data
models `ItemSocket` and `ShadowResistanceItem`.

Usage:
    python3 extract_reference_data.py <path-to-source.xlsx>

Writes data/item-sockets.json and data/shadow-resistance-items.json next to
this script. These two tabs are hidden sheets named "sockets" and
"shadow resistance config" in the source workbook, each a two-column
(item id, value) table with a header row.

"sockets" is fully literal. "shadow resistance config" is mostly literal but
216 of its rows are a Google Sheets IMPORTRANGE formula pulling additional
items from an external reference workbook (`moreSRConf`) — since this file
is a frozen xlsx export, those cells read back as
`=IFERROR(__xludf.DUMMYFUNCTION("..."), <cached value>)` instead of a plain
number. The cached fallback value (the IFERROR's second argument) is the
real, correct value Google Sheets had computed at export time, so we recover
it with a regex instead of skipping those rows.
"""

import json
import re
import sys
from pathlib import Path

import openpyxl

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"

# Matches the trailing `, <fallback>)` of `=IFERROR(__xludf.DUMMYFUNCTION("...", <fallback>)`
# and captures a quoted string or bare number as the fallback.
DUMMYFUNCTION_FALLBACK = re.compile(r',\s*(?:"((?:[^"]|"")*)"|(-?\d+(?:\.\d+)?))\s*\)$')


def resolve_cell(value):
    if isinstance(value, str) and value.startswith("="):
        match = DUMMYFUNCTION_FALLBACK.search(value)
        if not match:
            raise ValueError(f"Could not extract cached value from formula: {value!r}")
        quoted, bare = match.groups()
        return quoted.replace('""', '"') if quoted is not None else bare
    return value


def extract_two_column_sheet(ws, value_field_name: str) -> list[dict]:
    """
    Returns one row per distinct itemId. Where the sheet lists the same
    itemId twice with different values (seen in "shadow resistance config",
    where a hardcoded block and an appended external-reference block
    overlap), the later row in sheet order wins — DynamoDB itself would
    behave the same way on a keyed write, and the appended block is the
    more actively maintained external source. Conflicts are reported so
    they can be spot-checked rather than silently resolved.
    """
    by_id: dict[int, int] = {}
    conflicts: list[tuple[int, int, int]] = []
    for row in ws.iter_rows(min_row=2, max_col=2, values_only=True):
        item_id, value = row
        if item_id is None or value is None:
            continue
        item_id = int(float(resolve_cell(item_id)))
        value = int(float(resolve_cell(value)))
        if item_id in by_id and by_id[item_id] != value:
            conflicts.append((item_id, by_id[item_id], value))
        by_id[item_id] = value

    if conflicts:
        print(
            f"  warning: {len(conflicts)} itemIds had conflicting {value_field_name} "
            f"values across duplicate rows; kept the later one each time. Examples:"
        )
        for item_id, old, new in conflicts[:10]:
            print(f"    itemId {item_id}: {old} -> {new}")

    return [{"itemId": k, value_field_name: v} for k, v in by_id.items()]


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    source_path = Path(sys.argv[1])
    wb = openpyxl.load_workbook(source_path, data_only=False)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    sockets = extract_two_column_sheet(wb["sockets"], "sockets")
    (DATA_DIR / "item-sockets.json").write_text(json.dumps(sockets, indent=2))
    print(f"item-sockets.json: {len(sockets)} rows")

    sr_items = extract_two_column_sheet(
        wb["shadow resistance config"], "srValue"
    )
    (DATA_DIR / "shadow-resistance-items.json").write_text(
        json.dumps(sr_items, indent=2)
    )
    print(f"shadow-resistance-items.json: {len(sr_items)} rows")


if __name__ == "__main__":
    main()
