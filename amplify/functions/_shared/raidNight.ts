import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/**
 * One RaidNight row per ingested WCL report. It serves two readers:
 *
 *  1. The Raid Reports list, which pages through these rows (15 at a time, newest
 *     first) instead of reading every encounter row.
 *  2. The sidebar's Hall of Records, which sums these rows instead of scanning
 *     Report, DeathRecord and GearListing (~19k items, ~30 MB, ~17 s) on every
 *     page load. Each row carries that raid's own contribution to every record:
 *     boss kills/wipes/seconds, every death with its time, the roster's classes,
 *     and the best critical hit / heal per fight.
 *
 * Everything except the crit records is derived from this report's rows in
 * DynamoDB, so it can be recomputed at any time and never drifts. Crit records
 * come from WCL and cannot be rebuilt from the database, so they are carried
 * forward from the existing row (see `critByFight`) and only replaced when fresh
 * data is passed in.
 *
 * Rollups are per raid, not one global row: each raid recomputes independently, so
 * concurrent ingests can never race on a shared read-modify-write.
 *
 * Counts use the rule the UI has always used: boss attempts with a non-zero
 * duration (zero/null-duration rows are WCL glitches and are hidden), with all
 * attempts on one boss collapsing to a single encounter.
 */
export const RAID_LIST_KEY = 'RAID';

/** One crit record: who, how big, with what, on which boss, and when. */
export interface CritRecord {
  name: string | null;
  /** Damage: the hit. Healing: gross heal (effective + overheal). */
  amount: number;
  ability: string | null;
  /** Encounter name, from Report.encounterName. */
  boss: string | null;
  fightId: string;
  /** ISO date of the fight, from Report.fightDate. */
  at: string | null;
}

export interface FightCritEntry {
  damage?: CritRecord;
  healing?: CritRecord;
}

export interface RaidNightTables {
  report: string;
  raidNight: string;
  deathRecord: string;
  gearListing: string;
}

interface ReportRowLike {
  fightId: string;
  title?: string | null;
  zone?: string | null;
  fightDate?: string | null;
  durationSeconds?: number | null;
  encounterName?: string | null;
  isBossEncounter?: boolean | null;
  kill?: boolean | null;
  encounterGroupKey?: string | null;
}

async function queryAll<T>(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  reportCode: string,
  projection?: { expression: string; names?: Record<string, string> }
): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'reportCode = :reportCode',
        ExpressionAttributeValues: { ':reportCode': reportCode },
        ...(projection ? { ProjectionExpression: projection.expression } : {}),
        ...(projection?.names ? { ExpressionAttributeNames: projection.names } : {}),
        ExclusiveStartKey: startKey,
      })
    );
    items.push(...((res.Items ?? []) as T[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** DeathRecord.deaths is stored as a native list but can surface as a JSON string. */
function parseDeaths(raw: unknown): Array<{ timeMs?: number }> {
  if (Array.isArray(raw)) return raw as Array<{ timeMs?: number }>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Best record of each kind across a raid's fights; ties go to the earliest fight. */
function topOf(entries: FightCritEntry[], kind: 'damage' | 'healing'): CritRecord | undefined {
  let best: CritRecord | undefined;
  for (const entry of entries) {
    const c = entry[kind];
    if (!c) continue;
    if (!best || c.amount > best.amount || (c.amount === best.amount && (c.at ?? '') < (best.at ?? ''))) best = c;
  }
  return best;
}

export async function recomputeRaidNight(
  ddb: DynamoDBDocumentClient,
  tables: RaidNightTables,
  reportCode: string,
  opts?: { critByFight?: Record<string, FightCritEntry> }
): Promise<void> {
  const rows = await queryAll<ReportRowLike>(ddb, tables.report, reportCode);
  const boss = rows.filter((r) => r.isBossEncounter && !!r.durationSeconds);

  // Nothing displayable left (e.g. the last attempt was deleted): the raid
  // must disappear from the list rather than linger as an empty shell.
  if (boss.length === 0) {
    await ddb.send(new DeleteCommand({ TableName: tables.raidNight, Key: { reportCode } }));
    return;
  }

  // --- list fields --------------------------------------------------------
  // Attempts on one boss share an encounterGroupKey; a one-off has none and
  // stands alone.
  const encounters = new Map<string, boolean>(); // key -> any attempt killed
  for (const r of boss) {
    const key = r.encounterGroupKey ?? `fight:${r.fightId}`;
    encounters.set(key, (encounters.get(key) ?? false) || !!r.kill);
  }
  // The list has always titled/dated a raid by its latest fight.
  const latest = boss.reduce((a, b) => ((b.fightDate ?? '') > (a.fightDate ?? '') ? b : a));
  const title = latest.title ?? reportCode;
  const bossNames = Array.from(new Set(boss.map((r) => r.encounterName).filter((n): n is string => !!n)));

  // --- Hall of Records fields --------------------------------------------
  const killAttempts = boss.filter((r) => r.kill).length;
  const wipeAttempts = boss.length - killAttempts;
  const bossSeconds = boss.reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0);

  // "Records kept since" has always been the earliest fight across everything
  // ingested, trash windows included.
  const dates = rows.map((r) => r.fightDate).filter((d): d is string => !!d);
  const firstFightDate = dates.length > 0 ? dates.reduce((min, d) => (d < min ? d : min)) : null;

  // A death's absolute time is its encounter's start plus the offset WCL reports
  // within that fight, so a raid straddling a reset boundary splits correctly.
  // An encounter with no Report row can't be placed in time: stored as null and
  // counted as current rather than dropped.
  const fightStart = new Map<string, number>();
  for (const r of rows) if (r.fightDate) fightStart.set(r.fightId, Date.parse(r.fightDate));

  const deathRows = await queryAll<{ fightId: string; characterName: string; deaths: unknown }>(
    ddb,
    tables.deathRecord,
    reportCode,
    { expression: 'fightId, characterName, deaths' }
  );
  const deathEvents: Record<string, Array<number | null>> = {};
  for (const row of deathRows) {
    const base = fightStart.get(row.fightId);
    const list = (deathEvents[row.characterName] ??= []);
    for (const death of parseDeaths(row.deaths)) {
      list.push(base === undefined ? null : Math.floor((base + (death.timeMs ?? 0)) / 1000));
    }
  }

  // Roster classes (for colouring names). GearListing rows are large (gear JSON),
  // but this reads only name + class, and only on ingest/delete — never on view.
  const gearRows = await queryAll<{ characterName: string; characterClass?: string | null }>(
    ddb,
    tables.gearListing,
    reportCode,
    { expression: 'characterName, characterClass' }
  );
  const classes: Record<string, string> = {};
  for (const g of gearRows) if (g.characterName && g.characterClass && !classes[g.characterName]) classes[g.characterName] = g.characterClass;

  // --- crit records --------------------------------------------------------
  // Carried forward from the existing row, overlaid with any fresh results, then
  // pruned to fights that still exist — so deleting the attempt that held a crit
  // correctly lowers the raid's record.
  const existing = await ddb.send(new GetCommand({ TableName: tables.raidNight, Key: { reportCode } }));
  const merged: Record<string, FightCritEntry> = {
    ...((existing.Item?.critByFight as Record<string, FightCritEntry> | undefined) ?? {}),
    ...(opts?.critByFight ?? {}),
  };
  const liveFightIds = new Set(boss.map((r) => r.fightId));
  const critByFight: Record<string, FightCritEntry> = {};
  for (const [fightId, entry] of Object.entries(merged)) if (liveFightIds.has(fightId)) critByFight[fightId] = entry;
  const entries = Object.values(critByFight);
  const topCritDamage = topOf(entries, 'damage');
  const topCritHeal = topOf(entries, 'healing');

  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: tables.raidNight,
      Item: {
        reportCode,
        listKey: RAID_LIST_KEY,
        title,
        zone: latest.zone ?? null,
        fightDate: latest.fightDate ?? null,
        bossCount: encounters.size,
        killedCount: Array.from(encounters.values()).filter(Boolean).length,
        // Lowercased so the list's search can use a plain `contains`.
        searchText: `${title} ${bossNames.join(' ')}`.toLowerCase(),
        killAttempts,
        wipeAttempts,
        bossSeconds,
        firstFightDate,
        deathEvents,
        classes,
        critByFight,
        // Omitted (not undefined) when absent: the delete Lambda's client does not
        // strip undefined values.
        ...(topCritDamage ? { topCritDamage } : {}),
        ...(topCritHeal ? { topCritHeal } : {}),
        // Written directly to DynamoDB, so AppSync needs these set by hand or
        // it returns the row as null.
        createdAt: existing.Item?.createdAt ?? now,
        updatedAt: now,
      },
    })
  );
}
