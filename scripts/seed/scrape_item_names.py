"""
Builds scripts/seed/data/item-names.json (item id -> name) for the ItemName
reference table.

Why this exists: WCL's combatantInfo.gear sometimes omits `name` on every
item of every character in a report — confirmed live against report
1mnvkwFDa2TXZr8W, where all 19 items on all 25 raiders came back with
id/slot/quality/icon and no name at all. Without a name the Gear Listing
tab filters the item out entirely and Gear Issues renders an empty link,
so a whole raid night's gear analysis is unusable. The ids are always
present, so the ingest worker backfills names from this table.

Source is the same wowsims/tbc tooltip CSV already used for gem data
(see scrape_gem_qualities.py for the parsing gotcha this shares: the
embedded tooltip JSON uses \" escaping, which is invalid RFC4180 CSV
quoting, so a plain csv.reader mis-parses nearly every row).

Only equippable gear is kept. The full dump is ~30k rows including
consumables, recipes and quest items, none of which can appear in a gear
slot — filtering keeps the table (and the ingest-time lookup) small.

Usage:
    python3 scrape_item_names.py
"""

import json
import re
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"

SOURCE_REF = "master"
TOOLTIPS_URL = (
    f"https://raw.githubusercontent.com/wowsims/tbc/{SOURCE_REF}/assets/item_data/all_item_tooltips.csv"
)

# id, name, quality, and the tooltip body (which carries the equip slot text).
TOOLTIP_PATTERN = re.compile(
    r'^(\d+),https://tbc\.wowhead\.com/tooltip/item/\d+&json,'
    r'\{"name":"((?:[^"\\]|\\.)*)","quality":(\d+),"icon":"((?:[^"\\]|\\.)*)","tooltip":"((?:[^"\\]|\\.)*)"',
    re.MULTILINE,
)

# Equip-slot labels Blizzard renders in the left column of an item tooltip.
# An item showing one of these is wearable, which is exactly the set that can
# turn up in combatantInfo.gear.
EQUIP_SLOT_MARKERS = [
    "Head", "Neck", "Shoulder", "Back", "Chest", "Shirt", "Tabard", "Wrist",
    "Hands", "Waist", "Legs", "Feet", "Finger", "Trinket", "Ranged", "Relic",
    "Thrown", "Two-Hand", "One-Hand", "Main Hand", "Off Hand", "Held In Off-hand",
    "Held In Off-Hand", "Wand", "Idol", "Libram", "Totem", "Sigil", "Shield",
    "Projectile", "Ammo", "Robe",
]
SLOT_RE = re.compile("|".join(re.escape(m) for m in EQUIP_SLOT_MARKERS))


def fetch(url: str) -> str:
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def main():
    print(f"fetching {TOOLTIPS_URL}")
    text = fetch(TOOLTIPS_URL)

    rows = []
    total = 0
    for m in TOOLTIP_PATTERN.finditer(text):
        total += 1
        item_id = int(m.group(1))
        name = m.group(2).replace('\\"', '"')
        tooltip = m.group(5)
        if not name:
            continue
        if not SLOT_RE.search(tooltip):
            continue
        rows.append({"itemId": item_id, "name": name})

    print(f"  parsed {total} tooltip rows")
    print(f"  kept {len(rows)} equippable items")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = DATA_DIR / "item-names.json"
    out.write_text(json.dumps(rows, indent=2))
    print(f"item-names.json: {len(rows)} rows ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
