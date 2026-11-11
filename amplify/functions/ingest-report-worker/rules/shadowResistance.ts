/**
 * Reimplements the original spreadsheet's "shadow resi" tab: total Shadow
 * Resistance from gear plus from buffs/race, for fights where SR matters.
 *
 * srFromGear counts two things, both off the gear array already fetched for
 * GearListing — no extra WCL calls:
 *
 *   1. the item's own SR, via the seeded ShadowResistanceItem table, and
 *   2. SR added by a gear *enhancement* — head glyphs, shoulder
 *      inscriptions, cloak/shield enchants and armor kits — via the seeded
 *      ShadowResistanceEnchant table.
 *
 * (2) was missing until it was spotted on a live Mother Shahraz kill, where
 * 19 of 25 raiders were being under-counted, several by 35 SR.
 *
 * Enchant values must come from that table and NOT from WCL's
 * `permanentEnchantName`. WCL returns the *modern retail* name and value for
 * an enchant id, which has been rescaled since TBC: it calls the +20 Glyph of
 * Shadow Warding "+6 Shadow Resistance" and the +7 Inscription of Endurance
 * "+2 All Resistances". The table's values come from TBC item tooltips.
 *
 * That retail string is still useful as a *detector*, though: the rescaling
 * changes the number but keeps the word "Resistance". So any enchant WCL
 * describes as resistance-granting that we have no value for is recorded in
 * `unmappedResistEnchants` rather than being silently dropped — which is how
 * the shield enchant (1888) and minor cloak resistance (903) were found after
 * the first pass. Enchants for a single non-shadow school (Fire/Frost/Nature/
 * Arcane Warding and friends) are deliberately ignored by that detector, or it
 * would cry wolf on every frost-resist glyph in the raid.
 *
 * srFromBuffsAndRace is a single flat bonus for having "Prayer of Shadow
 * Protection" active (guid 39374 — found empirically by searching a live
 * report's raid-wide buff list for anything with "shadow"/"protection" in
 * the name, not guessed). The +70 SR value matches the one example row
 * decoded from the original workbook's cached data (all four sampled
 * characters showed exactly 70 in this column) rather than a generic
 * spell-database lookup, since that's the only real data point available
 * to confirm the exact number against. No WoW race has an innate Shadow
 * Resistance bonus, so "and race" in the original column name appears to
 * be vestigial/unused in practice — not reimplemented.
 */

export interface WclGearItemForSR {
  id: number;
  slot?: number;
  permanentEnchant?: number;
  permanentEnchantName?: string;
  gems?: Array<{ id?: number }>;
}

/**
 * Shadow Resistance from a character's race. TBC's racial resistances are
 * fixed and will never change, so they're hard-coded rather than seeded.
 *
 * Only the shadow component counts here: Dwarf (Frost), Gnome (Arcane) and
 * Night Elf / Tauren (Nature) all have a racial resistance, but none of it
 * is shadow, so they resolve to 0 rather than being left out — the zero is
 * the finding.
 */
const RACE_SHADOW_RESISTANCE: Record<string, number> = {
  Draenei: 10,
  Undead: 10,
  Scourge: 10, // WoW's internal name for Forsaken
  Forsaken: 10,
  BloodElf: 5, // Magic Resistance: +5 to all five schools
  'Blood Elf': 5,
  Dwarf: 0,
  Gnome: 0,
  NightElf: 0,
  'Night Elf': 0,
  Tauren: 0,
  Human: 0,
  Orc: 0,
  Troll: 0,
};

const PRAYER_OF_SHADOW_PROTECTION_GUID = 39374;
const PRAYER_OF_SHADOW_PROTECTION_SR = 70;

/**
 * Matches WCL's retail label for anything that grants shadow resistance,
 * directly or as part of an all-schools enchant. Single-school enchants for
 * the other four schools are excluded — they're resistance, but not *shadow*
 * resistance, and flagging them would bury the real gaps.
 */
const RESIST_LABEL = /resist/i;
const NON_SHADOW_SCHOOL = /\b(fire|frost|nature|arcane)\b/i;

/**
 * The label check has one known blind spot: armor kits. Retail didn't just
 * rescale the resistance kits, it re-statted them — WCL reports the Frost
 * and Nature kits as "+2 Stamina", with no trace of the word "Resistance".
 * The Shadow Armor Kit (+8, enchant 2984) sat on 204 pieces of guild gear
 * looking exactly like a stamina enchant, and no per-row heuristic could
 * tell it from the ordinary chest and glove enchants on those same slots.
 *
 * Kits are instead distinguished by a property no single row carries: a kit
 * appears across several of {Chest, Legs, Feet, Hands}, whereas a chest
 * enchant only ever appears on a chest. That's a corpus-level check — run
 * it over the whole GearListing table when an unexplained enchant shows up,
 * not here, where it would flag every Exceptional Stats chest enchant.
 *
 * The known kit family is pinned in ShadowResistanceEnchant instead: the
 * shadow one at its real +8, and the irrelevant ones (Frost, Nature, Heavy
 * Knothide) at srValue 0 rather than left out, which records the finding
 * and stops them being re-examined.
 */

export interface ShadowResistanceAnalysis {
  srFromGear: number;
  srFromBuffsAndRace: number;
  srTotal: number;
  gearNotes: string[];
  unmappedResistEnchants: string[];
}

export function analyzeShadowResistance(
  gear: WclGearItemForSR[],
  itemSrValues: Map<number, number>,
  enchantSrValues: Map<number, { srValue: number; name: string }>,
  playerBuffGuids: Set<number>,
  race?: string | null
): ShadowResistanceAnalysis {
  const gearNotes: string[] = [];
  const unmappedResistEnchants: string[] = [];
  let srFromGear = 0;

  for (const item of gear) {
    const sr = itemSrValues.get(item.id);
    if (sr) {
      srFromGear += sr;
      gearNotes.push(`item ${item.id}: +${sr} SR`);
    }

    // Socketed gems. Only two TBC gems carry resistance — Void Sphere
    // (+4 all) and Prismatic Sphere (+3 all) — and both read "+N Resist
    // All" on the tooltip, which is why a sweep for "all resistances"
    // missed them. Gem ids are item ids, so they share itemSrValues.
    for (const gem of item.gems ?? []) {
      if (gem?.id === undefined) continue;
      const gemSr = itemSrValues.get(gem.id);
      if (gemSr) {
        srFromGear += gemSr;
        gearNotes.push(`gem ${gem.id}: +${gemSr} SR`);
      }
    }

    if (!item.permanentEnchant) continue;

    const enchant = enchantSrValues.get(item.permanentEnchant);
    if (enchant) {
      srFromGear += enchant.srValue;
      // A 0 row means "checked, grants no shadow resistance" — real data,
      // but not worth a line in the notes.
      if (enchant.srValue > 0) {
        gearNotes.push(`enchant ${item.permanentEnchant} (${enchant.name}): +${enchant.srValue} SR`);
      }
      continue;
    }

    const label = item.permanentEnchantName ?? '';
    if (RESIST_LABEL.test(label) && !NON_SHADOW_SCHOOL.test(label)) {
      // Worth a look, not worth a guess: WCL's number is the rescaled retail
      // one, so recording it as SR would be wrong. Surface it instead.
      unmappedResistEnchants.push(`${item.permanentEnchant}: ${label} (slot ${item.slot ?? '?'}, item ${item.id})`);
    }
  }

  const srFromBuff = playerBuffGuids.has(PRAYER_OF_SHADOW_PROTECTION_GUID)
    ? PRAYER_OF_SHADOW_PROTECTION_SR
    : 0;

  // An unknown race contributes 0 rather than a guess. WCL carries no race
  // data at all (checked: playerDetails has class, server, region and
  // faction, and combatantInfo.stats has no resistances), so it comes from
  // the CharacterRace table and is simply absent for anyone not yet listed.
  const srFromRace = race ? (RACE_SHADOW_RESISTANCE[race] ?? 0) : 0;
  if (srFromRace > 0) gearNotes.push(`race ${race}: +${srFromRace} SR`);

  const srFromBuffsAndRace = srFromBuff + srFromRace;

  return {
    srFromGear,
    srFromBuffsAndRace,
    srTotal: srFromGear + srFromBuffsAndRace,
    gearNotes,
    unmappedResistEnchants,
  };
}
