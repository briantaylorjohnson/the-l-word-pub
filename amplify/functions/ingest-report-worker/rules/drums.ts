/**
 * Reimplements the original spreadsheet's "drums" tab: for each drummer,
 * how many drums did they cast, how many raid members did each cast
 * actually buff on average, and how many casts buffed nobody at all
 * (matching a comment found on the original sheet: "these were pointless
 * casts and drums were applied to 0 targets").
 *
 * Verified directly against a live report rather than assumed:
 * - The cast event's ability guid and the resulting buff aura's guid are
 *   the *same* ID (confirmed: "Drums of Battle", guid 35476, appears
 *   identically as both a `cast` event and the `applybuff` events it
 *   produces).
 * - Unlike consumables (elixirs/flasks/food, almost always applied before
 *   the pull and thus outside any fight-scoped event window), drum casts
 *   happen mid-fight, so raw `cast`/`applybuff` events *within* the fight
 *   window are sufficient — no need for the wider-window/table-view
 *   workaround consumables.ts uses.
 *
 * Only "Drums of Battle" (35476) was actually observed in a live report
 * this session. "Drums of War" (35475) and "Drums of Restoration" (35478)
 * are included on the strength of Blizzard's usual pattern of assigning
 * sequential spell IDs to an item family added together, but are NOT
 * independently confirmed — if a report's drum stats look wrong, this is
 * the first place to check.
 */

const DRUM_ABILITY_GUIDS = new Set([35475, 35476, 35478]);

// A cast's applybuff events land within a few ms of the cast itself, but
// not reliably *after* it — confirmed directly: several buff-application
// timestamps came back 1-2ms *before* their triggering cast's timestamp
// (simultaneous game-tick events aren't guaranteed to log in cast-then-
// effect order). The window is generous in both directions; drums have a
// multi-minute cooldown, so there's no risk of it bleeding into a
// different cast by the same source.
const CAST_TO_BUFF_WINDOW_BEFORE_MS = 1000;
const CAST_TO_BUFF_WINDOW_AFTER_MS = 3000;

export interface WclCastEvent {
  type: string;
  timestamp: number;
  sourceID: number;
  ability: { guid: number };
}

export interface WclApplyBuffEvent {
  type: string;
  timestamp: number;
  sourceID: number;
  targetID: number;
  ability: { guid: number };
}

export interface DrumStatRow {
  characterName: string;
  totalDrums: number;
  totalBuffsGranted: number;
  buffsPerDrum: number;
  pointlessCasts: number;
}

export function analyzeDrums(
  castEvents: WclCastEvent[],
  applyBuffEvents: WclApplyBuffEvent[],
  actorIdToName: Map<number, string>
): DrumStatRow[] {
  const drumCasts = castEvents
    .filter((e) => e.type === 'cast' && DRUM_ABILITY_GUIDS.has(e.ability.guid))
    .sort((a, b) => a.timestamp - b.timestamp);

  const drumBuffs = applyBuffEvents.filter(
    (e) => e.type === 'applybuff' && DRUM_ABILITY_GUIDS.has(e.ability.guid)
  );

  const bySource = new Map<number, { casts: typeof drumCasts; buffsGranted: number; pointless: number }>();

  for (const cast of drumCasts) {
    const entry = bySource.get(cast.sourceID) ?? { casts: [], buffsGranted: 0, pointless: 0 };
    entry.casts.push(cast);
    bySource.set(cast.sourceID, entry);
  }

  for (const [sourceID, entry] of bySource) {
    for (const cast of entry.casts) {
      const targetsHit = drumBuffs.filter(
        (b) =>
          b.sourceID === sourceID &&
          b.timestamp >= cast.timestamp - CAST_TO_BUFF_WINDOW_BEFORE_MS &&
          b.timestamp <= cast.timestamp + CAST_TO_BUFF_WINDOW_AFTER_MS
      ).length;
      entry.buffsGranted += targetsHit;
      if (targetsHit === 0) entry.pointless += 1;
    }
  }

  return Array.from(bySource.entries())
    .map(([sourceID, entry]) => ({
      characterName: actorIdToName.get(sourceID) ?? `actor ${sourceID}`,
      totalDrums: entry.casts.length,
      totalBuffsGranted: entry.buffsGranted,
      buffsPerDrum: entry.casts.length > 0 ? entry.buffsGranted / entry.casts.length : 0,
      pointlessCasts: entry.pointless,
    }))
    .filter((row) => row.totalDrums > 0);
}
