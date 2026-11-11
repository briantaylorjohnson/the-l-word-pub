/**
 * Damage per player for one boss encounter.
 *
 * Source is WCL's `damage-done` table with no target filter, so a player's
 * total is every point of damage they dealt to any hostile inside the fight
 * window — bosses and adds alike. Pets are already folded into their owner
 * by WCL. Verified live: each entry's per-target breakdown sums exactly to
 * its total.
 */

export interface WclDamageEntry {
  name: string;
  type?: string;
  total: number;
  activeTime?: number;
}

export interface DamageTableResponse {
  entries?: WclDamageEntry[];
  totalTime?: number;
}

export interface DamageStatRow {
  characterName: string;
  totalDamage: number;
  dps: number;
  activeTimeMs: number;
  pctOfRaid: number;
}

export function analyzeDamage(table: DamageTableResponse, fightDurationMs: number): DamageStatRow[] {
  // Entries without a class `type` (pets/NPCs that WCL occasionally lists
  // separately) are not raiders and must not dilute anyone's share.
  const entries = (table.entries ?? []).filter((e) => e.name && e.total > 0 && e.type && e.type !== 'Pet' && e.type !== 'NPC');
  const raidTotal = entries.reduce((sum, e) => sum + e.total, 0);
  // DPS over the whole fight window, which is how WCL's own DPS and
  // rankings are expressed — not over the player's active time.
  const seconds = (table.totalTime ?? fightDurationMs) / 1000;

  return entries.map((e) => ({
    characterName: e.name,
    totalDamage: e.total,
    dps: seconds > 0 ? Math.round((e.total / seconds) * 10) / 10 : 0,
    activeTimeMs: e.activeTime ?? 0,
    pctOfRaid: raidTotal > 0 ? Math.round((e.total / raidTotal) * 10000) / 100 : 0,
  }));
}
