"""
Builds scripts/seed/data/enchant-names.json (enchant effect id -> TBC
display name) for the EnchantName reference table, used by the Gear
Listing tab.

Why this exists: WCL v1's `permanentEnchantName` is the MODERN RETAIL name
for the enchant effect id, not the TBC one — effect 3003 comes back as
"+5 Attack Power and +5 Critical Strike" when in TBC it's Glyph of
Ferocity (+34 AP / +16 hit). The ids are correct; the names lie. Confirmed
against a real report (Oakenslug's Beast Lord Helm).

Sources, merged in order (first hit wins):
  1. wowsims/tbc sim/core/items/all_enchants.go — 76 raid-relevant TBC
     enchants with full names ("Glyph of Ferocity", "Bracer - Assault").
  2. wowaudit/core lib/constants/tbc_constants.rb — ~94 entries covering
     most of the rest ("Mongoose", "Major Healing").
  3. Local suboptimal-enchants.json labels — TBC-accurate short labels for
     old/inferior enchants ("Gloves - 7 Agi", "Boots - Minor Speed").
  4. MANUAL_OVERRIDES below — the tail that no public dataset carries,
     hand-identified from the items they appeared on in real reports
     (e.g. 464 on boots = Mithril Spurs, 3269 on a fishing pole = High
     Test Eternium Fishing Line).

Anything WCL sends that's still missing falls back to WCL's retail name at
display time — re-run this script and extend MANUAL_OVERRIDES if one shows
up that matters.

Usage:
    python3 scrape_enchant_names.py
"""

import json
import re
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"

WOWSIMS_URL = "https://raw.githubusercontent.com/wowsims/tbc/master/sim/core/items/all_enchants.go"
WOWAUDIT_URL = "https://raw.githubusercontent.com/wowaudit/core/master/lib/constants/tbc_constants.rb"

WOWSIMS_PATTERN = re.compile(r'EffectID: (\d+), Name: "((?:[^"\\]|\\.)*)",')
WOWAUDIT_PATTERN = re.compile(r'(\d+)\s*=>\s*\[\d+,\s*"((?:[^"\\]|\\.)*)"\]')

MANUAL_OVERRIDES = {
    464: "Mithril Spurs",
    1883: "Bracer - 7 Intellect",
    1888: "Shield - 5 All Resistances",
    2654: "Shield - 12 Intellect",
    2724: "Stabilized Eternium Scope",
    2933: "Chest - Major Resilience",
    2987: "Frost Armor Kit",
    2988: "Nature Armor Kit",
    3269: "High Test Eternium Fishing Line",
}


def fetch(url: str) -> str:
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def main():
    print(f"fetching {WOWSIMS_URL}")
    wowsims = {int(m.group(1)): m.group(2) for m in WOWSIMS_PATTERN.finditer(fetch(WOWSIMS_URL))}
    print(f"  {len(wowsims)} wowsims entries")

    print(f"fetching {WOWAUDIT_URL}")
    wowaudit = {int(m.group(1)): m.group(2) for m in WOWAUDIT_PATTERN.finditer(fetch(WOWAUDIT_URL))}
    print(f"  {len(wowaudit)} wowaudit entries")

    subopt: dict[int, str] = {}
    for row in json.loads((DATA_DIR / "suboptimal-enchants.json").read_text()):
        subopt.setdefault(row["enchantId"], row["label"])
    print(f"  {len(subopt)} suboptimal-enchant labels")

    merged: dict[int, str] = {}
    for source in (MANUAL_OVERRIDES, subopt, wowaudit, wowsims):
        merged.update(source)  # later sources win => wowsims highest priority

    rows = [{"enchantId": eid, "name": name} for eid, name in sorted(merged.items())]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "enchant-names.json").write_text(json.dumps(rows, indent=2))
    print(f"enchant-names.json: {len(rows)} rows")


if __name__ == "__main__":
    main()
