"""
Extract reference data from the external "CLA + RPB config TBC" workbook
(the shared Google Sheet the original tool pulled via IMPORTRANGE) into seed
JSON matching the Amplify Data models `SuboptimalEnchant`, `ExcludedGearItem`,
and `RaidValidationRule`.

Usage:
    python3 extract_external_reference_data.py <path-to-config.xlsx>

Source tabs:
  - "suboptimalEnchants" packs two unrelated flat lists into one sheet:
      columns A/B: enchantId (optionally "<id> [<slot>]") -> label
      columns D/E: itemId -> itemName (vanity items to exclude from gear checks)
  - "validateKaraLog", "validateSSCTKLog", "validateMHBTLog", "validateZALog",
    "validateSWLog": each a table of (npcIds, zone, bossName, minKills) in
    columns A:D. Columns E onward are translated boss names (VLOOKUP against
    langTexts) — irrelevant here since the rebuilt app ships static i18n
    JSON instead of a live translations table.
  - "buffConsumables": columns A/B/C/D/E are flat lists of buff-aura spell
    IDs per category (Battle Elixir/Guardian Elixir/Flask/Food Buff/
    Scrolls); column E's entries carry a class tag suffix like "33077
    [Agi]". Column G (JC neck usage) and column F (Weapon Enhancement,
    empty in this workbook) aren't extracted — weapon enhancement is
    checked from gear's own temporaryEnchant field instead (see
    consumables.ts for how that was verified).
"""

import json
import re
import sys
from pathlib import Path

import openpyxl

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR / "data"

ENCHANT_BRACKET = re.compile(r'^\s*(\d+)\s*(?:\[(\d+)\])?\s*$')

VALIDATE_SHEETS = [
    "validateKaraLog",
    "validateSSCTKLog",
    "validateMHBTLog",
    "validateZALog",
    "validateSWLog",
]


def extract_suboptimal_enchants(ws) -> list[dict]:
    rows = []
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=1, max_col=2, values_only=True):
        enchant_raw, label = row
        if enchant_raw is None or label is None:
            continue
        # Plain numeric rows (unambiguous enchants) come back as a bare
        # float from openpyxl, e.g. 2503.0 — only the disambiguated rows
        # are actual strings like "930 [9]".
        if isinstance(enchant_raw, (int, float)):
            enchant_id = int(enchant_raw)
            slot = -1
        else:
            match = ENCHANT_BRACKET.match(str(enchant_raw))
            if not match:
                raise ValueError(f"Unrecognized enchant id format: {enchant_raw!r}")
            enchant_id = int(match.group(1))
            slot = int(match.group(2)) if match.group(2) is not None else -1
        rows.append({"enchantId": enchant_id, "slot": slot, "label": str(label)})

    # De-dupe by (enchantId, slot) — DynamoDB's BatchWriteItem rejects a
    # request containing two items with the same key. The one duplicate
    # found in this sheet (enchantId 943, slot -1) has an identical label
    # both times, so this is a lossless collapse, not a real conflict.
    by_key: dict[tuple[int, int], dict] = {}
    for row in rows:
        key = (row["enchantId"], row["slot"])
        if key in by_key and by_key[key]["label"] != row["label"]:
            print(
                f"  warning: enchantId {key[0]} slot {key[1]} has conflicting labels: "
                f"{by_key[key]['label']!r} vs {row['label']!r}; kept the later one"
            )
        by_key[key] = row
    return list(by_key.values())


def extract_excluded_gear(ws) -> list[dict]:
    rows = []
    for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=4, max_col=5, values_only=True):
        item_id, item_name = row
        if item_id is None or item_name is None:
            continue
        rows.append({"itemId": int(item_id), "itemName": str(item_name)})
    return rows


def extract_validation_rules(wb) -> list[dict]:
    rows = []
    for sheet_name in VALIDATE_SHEETS:
        ws = wb[sheet_name]
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=1, max_col=4, values_only=True):
            npc_ids, zone, boss_name, min_kills = row
            if npc_ids is None or zone is None or boss_name is None or min_kills is None:
                continue
            npc_ids_str = str(int(npc_ids)) if isinstance(npc_ids, float) else str(npc_ids)
            rows.append(
                {
                    "zone": str(zone),
                    "bossName": str(boss_name),
                    "npcIds": npc_ids_str,
                    "minKills": int(min_kills),
                }
            )
    return rows


CONSUMABLE_COLUMNS = {
    "A": "battleElixir",
    "B": "guardianElixir",
    "C": "flask",
    "D": "food",
    "E": "scroll",
}

SCROLL_TAG = re.compile(r'^\s*(\d+)\s*\[([^\]]+)\]\s*$')


def extract_consumable_buffs(ws) -> list[dict]:
    col_index = {"A": 1, "B": 2, "C": 3, "D": 4, "E": 5}
    rows = []
    for col_letter, category in CONSUMABLE_COLUMNS.items():
        col = col_index[col_letter]
        for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=col, max_col=col, values_only=True):
            raw = row[0]
            if raw is None:
                continue
            note = None
            if isinstance(raw, str):
                match = SCROLL_TAG.match(raw)
                if not match:
                    raise ValueError(f"Unrecognized {category} spell id format: {raw!r}")
                spell_id = int(match.group(1))
                note = match.group(2)
            else:
                spell_id = int(raw)
            entry = {"spellId": spell_id, "category": category}
            if note:
                entry["note"] = note
            rows.append(entry)

    # A handful of spell IDs repeat verbatim within the same category
    # (harmless duplicate source rows) — de-dupe by (spellId, category) the
    # same way suboptimal-enchants does, since DynamoDB's key is that pair.
    by_key: dict[tuple[int, str], dict] = {}
    for row in rows:
        key = (row["spellId"], row["category"])
        by_key[key] = row
    return list(by_key.values())


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    source_path = Path(sys.argv[1])
    # data_only=True: unlike the main CLA workbook, this sheet's translation
    # columns are plain VLOOKUP formulas (not IMPORTRANGE/DUMMYFUNCTION), and
    # even row 1 of validateKaraLog's bossName is itself a formula — Excel's
    # cached values resolve all of that cleanly.
    wb = openpyxl.load_workbook(source_path, data_only=True)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    enchants = extract_suboptimal_enchants(wb["suboptimalEnchants"])
    (DATA_DIR / "suboptimal-enchants.json").write_text(json.dumps(enchants, indent=2))
    print(f"suboptimal-enchants.json: {len(enchants)} rows")

    excluded_gear = extract_excluded_gear(wb["suboptimalEnchants"])
    (DATA_DIR / "excluded-gear-items.json").write_text(json.dumps(excluded_gear, indent=2))
    print(f"excluded-gear-items.json: {len(excluded_gear)} rows")

    consumable_buffs = extract_consumable_buffs(wb["buffConsumables"])
    (DATA_DIR / "consumable-buffs.json").write_text(json.dumps(consumable_buffs, indent=2))
    print(f"consumable-buffs.json: {len(consumable_buffs)} rows")

    validation_rules = extract_validation_rules(wb)
    (DATA_DIR / "raid-validation-rules.json").write_text(json.dumps(validation_rules, indent=2))
    print(f"raid-validation-rules.json: {len(validation_rules)} rows")


if __name__ == "__main__":
    main()
