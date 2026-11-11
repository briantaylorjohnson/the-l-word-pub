/**
 * Reimplements the original spreadsheet's "gear issues" tab: flags gear
 * that's missing an enchant (or has a known-bad one), gear with an unfilled
 * gem socket, and gear with a filled-but-weak (below Rare quality) gem.
 *
 * Gem quality: WCL's v1 API gives each gem only {id, itemLevel, icon} — no
 * rarity, and every gem sampled from a real classic report came back with
 * itemLevel: 70 regardless of actual tier, a known WCL-classic quirk that
 * makes item level useless for inferring quality. `id` is a real, stable WoW
 * item ID though, and TBC's gem set is small and fixed (~240 items), so
 * quality is looked up from a standalone GemQuality reference table instead
 * — see scripts/seed/scrape_gem_qualities.py for how that table is sourced.
 */

export interface WclGem {
  id: number;
  itemLevel: number;
  icon: string;
}

export interface WclGearItem {
  id: number;
  slot: number;
  name?: string;
  quality: number;
  icon?: string;
  permanentEnchant?: number;
  permanentEnchantName?: string;
  gems?: WclGem[];
}

export interface GearIssueRefData {
  // key: `${enchantId}:${slot}` for slot-specific rows, `${enchantId}:-1` for unambiguous ones
  suboptimalEnchantLabels: Map<string, string>;
  excludedItemIds: Set<number>;
  // itemId -> expected gem socket count
  itemSocketCounts: Map<number, number>;
  // gem itemId -> quality tier name ('Common' | 'Uncommon' | 'Rare' | 'Epic')
  gemQualities: Map<number, string>;
}

export type GearIssueType = 'emptySlot' | 'noEnchant' | 'noGem' | 'weakEnchant' | 'weakGem';

export interface GearIssueEntry {
  slot: number;
  // 0 for 'emptySlot' — nothing to link to WowHead.
  itemId: number;
  itemName?: string;
  issueType: GearIssueType;
  // The suboptimal enchant's label (weakEnchant), or the gem's quality tier
  // name (weakGem). Absent for noEnchant/noGem/emptySlot.
  currentValue?: string;
}

// Gem qualities below this are considered "weak" — Rare and Epic are not.
const WEAK_GEM_QUALITIES = new Set(['Common', 'Uncommon']);

// Slots that can carry a permanent enchant in TBC. Rings/neck/trinkets
// can't be enchanted, so "no enchant" there isn't a real issue — this set
// matches exactly the slot numbers that actually appear in the
// SuboptimalEnchant reference data (0,2,4,6,7,8,9,14,16), plus 15
// (MainHand) since weapon enchants are stored unambiguously (slot -1)
// rather than under a specific bracketed slot number.
const ENCHANTABLE_SLOTS = new Set([0, 2, 4, 6, 7, 8, 9, 14, 15, 16]);

// OffHand (16) is ambiguous in a way no other enchantable slot is: it can
// hold a real one-hand weapon or shield (enchantable), or a "Held In
// Off-Hand" caster/healer stat-stick — an orb, tome, totem, libram, etc.
// — which cannot be enchanted at all in TBC. WCL's v1 API gives gear
// items only {id, slot, quality, icon, itemLevel} with no item-type/
// subclass field, so this checks the `icon` filename against Blizzard's
// own (fairly consistent) weapon/shield icon-naming convention instead.
// Validated against 16 real offhand items pulled live from this project's
// test report: every shield (inv_shield_*) and every dual-wieldable
// weapon (inv_sword_/inv_axe_/inv_mace_/inv_weapon_*) matched correctly,
// and every actual holdable — "Windcaller's Orb" (inv_misc_orb_01),
// "Talisman of the Sun King" (inv_offhand_blood_02), "Tears of Heaven"
// (inv_potion_75, a healer stat-stick styled as a vial), "Jewel of
// Infinite Possibilities" (inv_misc_gem_ebondraenite_02) — correctly did
// not. `inv_fist_`/`inv_gauntlets_` (fist weapons) are included on
// Blizzard's general icon-naming convention, not independently confirmed
// against a live fist-weapon offhand — no example turned up in the test
// data (no fist-weapon class/spec present in that raid).
const OFFHAND_WEAPON_OR_SHIELD_ICON_PREFIXES = [
  'inv_sword_',
  'inv_axe_',
  'inv_mace_',
  'inv_dagger_',
  'inv_fist_',
  'inv_gauntlets_',
  'inv_weapon_',
  'inv_shield_',
];

function isOffhandWeaponOrShield(icon: string | undefined): boolean {
  if (!icon) return false;
  return OFFHAND_WEAPON_OR_SHIELD_ICON_PREFIXES.some((prefix) => icon.startsWith(prefix));
}

// An unequipped slot comes back from WCL as `{id: 0, slot, quality: 1,
// itemLevel: 0}` with no `name`. Shirt(3), OffHand(16), and Tabard(18)
// are legitimately empty for most characters (cosmetic slots, or a
// two-hander occupying OffHand) — everything else empty is a real gearing
// gap worth flagging, matching the original tool's "flag empty item
// slots" feature. Ranged(17) IS expected filled: every TBC class has a
// ranged or relic option (wands, librams, totems, idols, bows, thrown),
// confirmed against a real 25-character raid where every single raider
// across all class archetypes had the slot filled.
const SLOTS_ALWAYS_EXPECTED_FILLED = new Set([0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]);

export function analyzeGear(gear: WclGearItem[], ref: GearIssueRefData): GearIssueEntry[] {
  const issues: GearIssueEntry[] = [];

  for (const item of gear) {
    if (item.id === 0) {
      if (SLOTS_ALWAYS_EXPECTED_FILLED.has(item.slot)) {
        issues.push({ slot: item.slot, itemId: 0, issueType: 'emptySlot' });
      }
      continue;
    }

    if (ref.excludedItemIds.has(item.id)) continue;

    if (item.permanentEnchant) {
      const label =
        ref.suboptimalEnchantLabels.get(`${item.permanentEnchant}:${item.slot}`) ??
        ref.suboptimalEnchantLabels.get(`${item.permanentEnchant}:-1`);
      if (label) {
        issues.push({
          slot: item.slot,
          itemId: item.id,
          itemName: item.name,
          issueType: 'weakEnchant',
          currentValue: label,
        });
      }
    } else if (
      ENCHANTABLE_SLOTS.has(item.slot) &&
      (item.slot !== 16 || isOffhandWeaponOrShield(item.icon))
    ) {
      issues.push({ slot: item.slot, itemId: item.id, itemName: item.name, issueType: 'noEnchant' });
    }

    const expectedSockets = ref.itemSocketCounts.get(item.id);
    const gems = item.gems ?? [];
    if (expectedSockets && gems.length < expectedSockets) {
      issues.push({ slot: item.slot, itemId: item.id, itemName: item.name, issueType: 'noGem' });
    }

    // Weak-gem check runs independent of the socket-count check above — a
    // ring could have one missing socket AND one present-but-weak gem at
    // the same time; these are separate issues.
    for (const gem of gems) {
      const quality = ref.gemQualities.get(gem.id);
      // An unrecognized gem id (not in the reference table) is silently
      // skipped, not flagged — same "deliberate gap" posture as an
      // enchantId/slot combo missing from suboptimalEnchantLabels.
      if (quality && WEAK_GEM_QUALITIES.has(quality)) {
        issues.push({
          slot: item.slot,
          itemId: item.id,
          itemName: item.name,
          issueType: 'weakGem',
          currentValue: quality,
        });
      }
    }
  }

  return issues;
}
