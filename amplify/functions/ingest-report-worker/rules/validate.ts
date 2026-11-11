/**
 * Reimplements the original spreadsheet's "validate" tab: does this report
 * contain enough kills of the required bosses/trash groups to legitimately
 * count as a clear of a given raid instance?
 *
 * WCL's `enemies[].guid` is the enemy's real NPC template ID — confirmed
 * directly against a live report (guid 21217 = "The Lurker Below", matching
 * the "SSC start point" npcId decoded from the reference workbook). Each
 * enemy's `fights[].instances` is how many copies of it were present in
 * that specific fight, which sums into a "how many of this NPC did we
 * kill" count — exactly what RaidValidationRule.minKills is checking.
 *
 * `kill: true/false` is only ever populated on fights with a nonzero
 * `boss` (a designated encounter) — confirmed directly against a live
 * report, where every trash-type fight (`boss: 0`) had `kill: undefined`.
 * Filtering all fights on `kill === true` therefore silently excludes
 * every trash pull, undercounting every trash-volume requirement to zero.
 * Trash fights count unconditionally; only boss encounters need the
 * explicit kill flag.
 *
 * NOT reimplemented: the original tool's zone-combination nuances (manual
 * zone override, trash-only vs. boss-only toggles, the "contains a valid
 * starting point" check). This validates every rule for every known zone
 * that appears anywhere in the report's fights — simpler, and correct for
 * the common case of one raid instance per report, but not a full port of
 * every edge case the spreadsheet's dropdown-driven UI handled.
 */

export interface WclFightForValidation {
  id: number;
  kill?: boolean;
  zoneID?: number;
  boss?: number;
}

export interface WclEnemy {
  guid: number;
  fights: Array<{ id: number; instances?: number }>;
}

export interface RaidValidationRuleRow {
  zone: string;
  bossName: string;
  npcIds: string;
  minKills: number;
}

export interface ZoneValidationDetail {
  bossName: string;
  npcIds: string;
  minKills: number;
  actualKills: number;
  passed: boolean;
}

export interface ValidationOutcome {
  zone: string;
  isValid: boolean;
  bossesRequired: number;
  bossesKilled: number;
  details: ZoneValidationDetail[];
}

// WCL's own zoneID for each instance we have validation rules for —
// decoded from the reference workbook's per-zone "zoneID"/"WCLzoneID"
// columns and confirmed against a live report (548 = Serpentshrine Cavern).
const ZONE_WCL_IDS: Record<string, number> = {
  Kara: 1047,
  SSC: 548,
  TK: 550,
  MH: 534,
  BT: 564,
  ZA: 1113,
  SW: 1114,
};

export function validateReport(
  fights: WclFightForValidation[],
  enemies: WclEnemy[],
  rules: RaidValidationRuleRow[]
): ValidationOutcome | null {
  const presentZoneCodes = Object.entries(ZONE_WCL_IDS)
    .filter(([, wclZoneId]) => fights.some((f) => f.zoneID === wclZoneId))
    .map(([zoneCode]) => zoneCode);

  if (presentZoneCodes.length === 0) return null;

  const countableFightIds = new Set(
    fights.filter((f) => (f.boss ? f.kill === true : true)).map((f) => f.id)
  );

  const killsByGuid = new Map<number, number>();
  for (const enemy of enemies) {
    const total = enemy.fights
      .filter((f) => countableFightIds.has(f.id))
      .reduce((sum, f) => sum + (f.instances ?? 1), 0);
    if (total > 0) killsByGuid.set(enemy.guid, total);
  }

  const relevantRules = rules.filter((r) => presentZoneCodes.includes(r.zone));

  const details: ZoneValidationDetail[] = relevantRules.map((rule) => {
    const npcIds = rule.npcIds.split(',').map((s) => Number(s.trim()));
    const actualKills = npcIds.reduce((sum, id) => sum + (killsByGuid.get(id) ?? 0), 0);
    return {
      bossName: rule.bossName,
      npcIds: rule.npcIds,
      minKills: rule.minKills,
      actualKills,
      passed: actualKills >= rule.minKills,
    };
  });

  const bossesRequired = details.length;
  const bossesKilled = details.filter((d) => d.passed).length;

  return {
    zone: presentZoneCodes.join('/'),
    isValid: bossesRequired > 0 && bossesKilled === bossesRequired,
    bossesRequired,
    bossesKilled,
    details,
  };
}
