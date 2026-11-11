/**
 * Reimplements the original spreadsheet's "buff consumables" tab: did this
 * character have a battle/guardian elixir or flask, food buff, scroll, and
 * weapon enhancement active during the fight, rolled into one score.
 *
 * Elixirs/flasks/food are almost always applied before the pull (often
 * before the log even starts recording), so raw `applybuff` events inside
 * the fight window mostly won't show them — confirmed directly: a known
 * flask visible in the fight's raid-wide buff *table* (aggregated uptime,
 * counts buffs already active at window start) produced zero matching
 * `applybuff` events even when queried from time 0. Per-player presence
 * therefore comes from the `buffs` table view filtered with `targetid`,
 * which reports uptime for buffs already active at the window's start —
 * confirmed against a live report ("Well Fed", guid 33263, showed full-
 * fight uptime for a player with no corresponding apply event).
 *
 * Weapon enhancement doesn't need a buff-table call at all — WCL's gear
 * data already carries `temporaryEnchant`/`temporaryEnchantName` directly
 * on the weapon item (confirmed live: e.g. "Superior Wizard Oil" showing
 * up as `temporaryEnchant` on several casters' weapons in the same gear
 * array `gearIssues`/`GearListing` already consume).
 *
 * NOT reimplemented: the original's per-class denominator adjustment
 * (e.g. excluding "scroll" from the average for classes that can't use
 * one) and the JC-neck usage counter. The score here averages whichever
 * of the four categories (elixir-or-flask, food, scroll, weapon
 * enhancement) are present, which slightly under-scores classes that
 * genuinely can't use one of them — a known, disclosed simplification.
 */

export interface WclGearItemForConsumables {
  slot: number;
  temporaryEnchant?: number;
}

export interface ConsumableBuffRow {
  spellId: number;
  category: string;
}

export interface ConsumableRefData {
  battleElixirIds: Set<number>;
  guardianElixirIds: Set<number>;
  flaskIds: Set<number>;
  foodIds: Set<number>;
  scrollIds: Set<number>;
}

export function buildConsumableRefData(rows: ConsumableBuffRow[]): ConsumableRefData {
  const byCategory = (category: string) =>
    new Set(rows.filter((r) => r.category === category).map((r) => r.spellId));
  return {
    battleElixirIds: byCategory('battleElixir'),
    guardianElixirIds: byCategory('guardianElixir'),
    flaskIds: byCategory('flask'),
    foodIds: byCategory('food'),
    scrollIds: byCategory('scroll'),
  };
}

export interface ConsumableAnalysis {
  battleElixir: number;
  guardianElixir: number;
  flask: number;
  food: number;
  scroll: number;
  weaponEnhancement: number;
  score: number;
}

export function analyzeConsumables(
  gear: WclGearItemForConsumables[],
  playerBuffGuids: Set<number>,
  ref: ConsumableRefData
): ConsumableAnalysis {
  const has = (ids: Set<number>) => [...playerBuffGuids].some((g) => ids.has(g));

  const battleElixir = has(ref.battleElixirIds) ? 1 : 0;
  const guardianElixir = has(ref.guardianElixirIds) ? 1 : 0;
  const flask = has(ref.flaskIds) ? 1 : 0;
  const food = has(ref.foodIds) ? 1 : 0;
  const scroll = has(ref.scrollIds) ? 1 : 0;

  const weaponSlots = gear.filter((g) => g.slot === 15 || g.slot === 16);
  const weaponEnhancement = weaponSlots.some((g) => g.temporaryEnchant) ? 1 : 0;

  // Flask replaces both elixir slots in TBC, so it's additive-but-capped
  // rather than averaged in on its own — matches the original's
  // `IF((battle+guardian)/2 + flask > 1, 1, ...)` formula.
  const elixirOrFlask = Math.min(1, (battleElixir + guardianElixir) / 2 + flask);

  const score = (elixirOrFlask + food + scroll + weaponEnhancement) / 4;

  return { battleElixir, guardianElixir, flask, food, scroll, weaponEnhancement, score };
}
