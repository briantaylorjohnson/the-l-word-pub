"""
Builds scripts/seed/data/gem-qualities.json (itemId -> quality tier) for the
GemQuality reference table, used by gearIssues.ts's "weak gem" check.

WCL v1's gem data (`{id, itemLevel, icon}`) has no usable quality signal —
itemLevel comes back as a flat 70 for every classic gem, a known WCL-classic
quirk. TBC's gem set is small and fixed (~240 items), so rather than scraping
Wowhead's listing UI directly (confirmed blocked: a plain request gets HTTP
403 from Wowhead's CloudFront edge, and the modern listing page hydrates its
table via client-side JS, not an inline payload), this pulls from the
open-source wowsims/tbc project (MIT-licensed), which already republishes
Wowhead's own per-item tooltip JSON (tbc.wowhead.com/tooltip/item/<id>&json)
as flat CSVs on raw.githubusercontent.com (no bot-protection):

  - assets/item_data/all_gem_ids.csv       (every known gem item ID)
  - assets/item_data/all_item_tooltips.csv (id -> {name, quality, ...})

Two fetches total, not one per gem.

Parsing gotcha: the tooltip JSON embedded in each tooltips-CSV row uses
backslash-escaped \" for quotes, which is not valid RFC4180 CSV quoting — a
plain csv.reader + json.loads per row silently mis-parses almost every row.
Instead this regex-matches the id/name/quality prefix directly out of the
raw CSV text, treating \" as an escaped char rather than a field terminator.

wowsims/tbc's `master` branch can move; re-run and diff the output before
reloading if reproducibility matters, or pin a commit SHA in SOURCE_REF.

Usage:
    python3 scrape_gem_qualities.py
"""

import json
import re
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"

SOURCE_REF = "master"
BASE_URL = f"https://raw.githubusercontent.com/wowsims/tbc/{SOURCE_REF}/assets/item_data"
GEM_IDS_URL = f"{BASE_URL}/all_gem_ids.csv"
TOOLTIPS_URL = f"{BASE_URL}/all_item_tooltips.csv"
# Same project's generated gem database — the only place carrying each
# gem's SOCKET color (Red/Yellow/Blue/Orange/Green/Purple/Meta), which the
# tooltip JSON lacks. ~212 of the 240 gems appear here; the rest keep a
# null color and the UI falls back to quality tinting.
ALL_GEMS_GO_URL = f"https://raw.githubusercontent.com/wowsims/tbc/{SOURCE_REF}/sim/core/items/all_gems.go"

TOOLTIP_PATTERN = re.compile(
    r'^(\d+),https://tbc\.wowhead\.com/tooltip/item/\d+&json,'
    r'\{"name":"((?:[^"\\]|\\.)*)","quality":(\d+)',
    re.MULTILINE,
)

GO_GEM_PATTERN = re.compile(
    r'\{Name: "((?:[^"\\]|\\.)*)", ID: (\d+), Phase: \d+, '
    r'Quality: proto\.ItemQuality_ItemQuality\w+, Color: proto\.GemColor_GemColor(\w+)'
)

# Standard WoW item-quality enum. 0/Poor and 5/Legendary never actually
# occur among real gems, but are mapped defensively rather than left to
# crash the script if the upstream data ever surprises us.
QUALITY_NAMES = {0: "Common", 1: "Common", 2: "Uncommon", 3: "Rare", 4: "Epic", 5: "Epic"}


def fetch(url: str) -> str:
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def parse_gem_ids(csv_text: str) -> set[int]:
    ids = set()
    for line in csv_text.splitlines()[1:]:
        line = line.strip()
        if line:
            ids.add(int(line))
    return ids


def parse_tooltips(csv_text: str) -> dict[int, tuple[str, int]]:
    by_id: dict[int, tuple[str, int]] = {}
    for match in TOOLTIP_PATTERN.finditer(csv_text):
        item_id = int(match.group(1))
        name = match.group(2).replace('\\"', '"')
        quality = int(match.group(3))
        by_id[item_id] = (name, quality)
    return by_id


def parse_gem_colors(go_text: str) -> dict[int, str]:
    colors: dict[int, str] = {}
    for match in GO_GEM_PATTERN.finditer(go_text):
        colors[int(match.group(2))] = match.group(3)  # e.g. 'Red', 'Meta'
    return colors


def main():
    print(f"fetching {GEM_IDS_URL}")
    gem_ids = parse_gem_ids(fetch(GEM_IDS_URL))
    print(f"  {len(gem_ids)} gem ids")

    print(f"fetching {TOOLTIPS_URL}")
    tooltips_by_id = parse_tooltips(fetch(TOOLTIPS_URL))
    print(f"  {len(tooltips_by_id)} parsed tooltip rows")

    print(f"fetching {ALL_GEMS_GO_URL}")
    colors_by_id = parse_gem_colors(fetch(ALL_GEMS_GO_URL))
    print(f"  {len(colors_by_id)} gem color entries")

    rows = []
    missing = []
    missing_color = 0
    for gem_id in sorted(gem_ids):
        tooltip = tooltips_by_id.get(gem_id)
        if tooltip is None:
            missing.append(gem_id)
            continue
        name, quality_int = tooltip
        color = colors_by_id.get(gem_id)
        if color is None:
            missing_color += 1
        rows.append(
            {"itemId": gem_id, "quality": QUALITY_NAMES[quality_int], "name": name, "color": color}
        )

    if missing:
        print(f"  WARNING: {len(missing)} gem ids had no tooltip match: {missing}")
    print(f"  gems without a socket color (UI falls back to quality tint): {missing_color}")

    distribution: dict[str, int] = {}
    for row in rows:
        distribution[row["quality"]] = distribution.get(row["quality"], 0) + 1
    print(f"  quality distribution: {distribution}")
    color_distribution: dict[str, int] = {}
    for row in rows:
        color_distribution[row["color"] or "unknown"] = color_distribution.get(row["color"] or "unknown", 0) + 1
    print(f"  color distribution: {color_distribution}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "gem-qualities.json").write_text(json.dumps(rows, indent=2))
    print(f"gem-qualities.json: {len(rows)} rows")


if __name__ == "__main__":
    main()
