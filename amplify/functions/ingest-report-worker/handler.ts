import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  BatchGetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { env } from '$amplify/env/ingest-report-worker';
import { analyzeGear, type GearIssueRefData, type WclGearItem } from './rules/gearIssues';
import { validateReport, type RaidValidationRuleRow } from './rules/validate';
import {
  analyzeConsumables,
  buildConsumableRefData,
  type ConsumableBuffRow,
} from './rules/consumables';
import { recomputeRaidNight, type FightCritEntry, type RaidNightTables } from '../_shared/raidNight';
import { analyzeDamage, type DamageTableResponse } from './rules/damage';
import { analyzeDrums, type WclCastEvent, type WclApplyBuffEvent } from './rules/drums';
import { analyzeShadowResistance } from './rules/shadowResistance';
import { groupEncounters } from './rules/groupEncounters';
import type { ReportFightsResponse, WclFight } from '../wcl-client/handler';

// removeUndefinedValues is load-bearing, not tidiness: WCL omits `name` on
// gear items for some reports entirely (confirmed live — every one of the
// 19 items on every character of report 1mnvkwFDa2TXZr8W came back with
// id/slot/quality/icon but no name). analyzeGear then produces
// `itemName: undefined`, which the document client refuses to marshal
// ("Pass options.removeUndefinedValues=true..."), rejecting the whole
// GearIssue write. Because each fight is processed under Promise.allSettled
// and its Report row is written last, that rejection silently dropped every
// boss encounter for the report while its trash rows survived — the raid
// looked half-ingested with no error surfaced to the admin.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const lambdaClient = new LambdaClient({});

// A live 51-fight raid report needs on the order of 1,400 WarcraftLogs
// calls to fully process (per fight: 1 summary + 1 buffs-table call per
// character + 2 events calls). Every one of those calls goes through this
// function invoking wcl-client, so this bounds how many are ever
// in-flight at once — regardless of how the surrounding loops are
// structured (fights and characters within a fight both just use
// Promise.all; this is the single real concurrency ceiling). Chosen to be
// gentle on WCL's API rather than tuned against a documented rate limit
// (v1 REST doesn't publish one) — comfortably fast at this volume either
// way (well under a minute of wall-clock WCL latency total).
const WCL_CONCURRENCY_LIMIT = 8;

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const wclSemaphore = new Semaphore(WCL_CONCURRENCY_LIMIT);

async function invokeWclClient<T>(payload: Record<string, unknown>): Promise<T> {
  const release = await wclSemaphore.acquire();
  try {
    const res = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: env.WCL_CLIENT_FUNCTION_NAME,
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );
    if (!res.Payload) throw new Error('wcl-client returned no payload');
    const body = JSON.parse(Buffer.from(res.Payload).toString('utf-8'));
    if (res.FunctionError) {
      throw new Error(`wcl-client error: ${body.errorMessage ?? JSON.stringify(body)}`);
    }
    return body as T;
  } finally {
    release();
  }
}

interface WclPlayerDetail {
  name: string;
  id: number;
  type?: string; // class name, e.g. "Paladin"
  specs?: string[];
  potionUse?: number;
  healthstoneUse?: number;
  combatantInfo?: { gear?: WclGearItem[] };
}

interface WclDeathEvent {
  name: string;
  deathTime: number; // ms relative to the fight window's start
  ability?: { name?: string };
}

interface SummaryTableResponse {
  playerDetails: {
    tanks?: WclPlayerDetail[];
    healers?: WclPlayerDetail[];
    dps?: WclPlayerDetail[];
  };
  deathEvents?: WclDeathEvent[];
}

interface BuffsTableResponse {
  auras: Array<{ guid: number }>;
}

interface EventsResponse<T> {
  events: T[];
}

// Small reference tables (a few thousand rows at most) — one full scan per
// ingest is simpler and cheaper than a point-read per gear item across
// every character in every fight.
async function scanAll<T>(tableName: string): Promise<T[]> {
  const all: T[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastEvaluatedKey })
    );
    all.push(...((res.Items ?? []) as T[]));
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return all;
}

async function loadGearIssueRefData(): Promise<GearIssueRefData> {
  const [enchants, excluded, sockets, gemQualityRows] = await Promise.all([
    scanAll<{ enchantId: number; slot: number; label: string }>(env.TABLE_NAME_SUBOPTIMALENCHANT),
    scanAll<{ itemId: number; itemName: string }>(env.TABLE_NAME_EXCLUDEDGEARITEM),
    scanAll<{ itemId: number; sockets: number }>(env.TABLE_NAME_ITEMSOCKET),
    // Cast, not a typed `env.` access: confirmed live that
    // `.amplify/generated/env/ingest-report-worker.ts` doesn't pick up
    // TABLE_NAME_GEMQUALITY even after a full successful deploy (unlike the
    // other TABLE_NAME_* entries, all added the same way via backend.ts's
    // readOnlyTables loop) — a gap in this Amplify version's local type
    // generator, not a deploy-ordering issue. The real deployed Lambda's
    // environment does have it (verified via `aws lambda
    // get-function-configuration`); this cast is the permanent workaround.
    scanAll<{ itemId: number; quality: string }>(
      (env as unknown as Record<string, string>).TABLE_NAME_GEMQUALITY
    ),
  ]);

  return {
    suboptimalEnchantLabels: new Map(enchants.map((e) => [`${e.enchantId}:${e.slot}`, e.label])),
    excludedItemIds: new Set(excluded.map((e) => e.itemId)),
    itemSocketCounts: new Map(sockets.map((s) => [s.itemId, s.sockets])),
    gemQualities: new Map(gemQualityRows.map((g) => [g.itemId, g.quality])),
  };
}

// Names are looked up by id in batches rather than scanning the whole
// ItemName table (20k+ rows): a raid night touches only a few hundred
// distinct items, and this runs once per encounter. Results are memoised
// for the lifetime of the Lambda container so a 12-encounter raid pays the
// lookup once, not twelve times.
const itemNameCache = new Map<number, string | null>();

async function backfillItemNames(gear: WclGearItem[]): Promise<void> {
  // Every unseen id is looked up, not just the nameless ones: knowing an
  // id is absent from the table is what lets the learn step below spot a
  // name worth recording.
  const needed = new Set<number>();
  for (const item of gear) {
    if (item.id && !itemNameCache.has(item.id)) needed.add(item.id);
  }

  const ids = Array.from(needed);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [(env as unknown as Record<string, string>).TABLE_NAME_ITEMNAME]: {
              Keys: chunk.map((itemId) => ({ itemId })),
            },
          },
        })
      );
      const found = (res.Responses?.[(env as unknown as Record<string, string>).TABLE_NAME_ITEMNAME] ??
        []) as Array<{ itemId: number; name: string }>;
      for (const row of found) itemNameCache.set(row.itemId, row.name);
    } catch (err) {
      // A lookup failure must not cost us the encounter — names are a
      // display nicety, the analysis itself only needs item ids.
      console.error('ItemName lookup failed:', err);
    }
    for (const id of chunk) if (!itemNameCache.has(id)) itemNameCache.set(id, null);
  }

  for (const item of gear) {
    if (item.id && !item.name) {
      const name = itemNameCache.get(item.id);
      if (name) item.name = name;
    }
  }

  // The seeded set comes from a TBC-era dataset, so Anniversary-realm
  // seasonal gear isn't in it. WCL does name those items in most reports —
  // when it does, record them so the next report that arrives without
  // names can resolve them too. The table teaches itself the gaps.
  const learned = new Map<number, string>();
  for (const item of gear) {
    if (item.id && item.name && itemNameCache.get(item.id) === null) {
      learned.set(item.id, item.name);
    }
  }
  for (const [itemId, name] of learned) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: (env as unknown as Record<string, string>).TABLE_NAME_ITEMNAME,
          Item: { itemId, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        })
      );
      itemNameCache.set(itemId, name);
    } catch (err) {
      console.error('ItemName learn failed:', err);
    }
  }
}

// Amplify Data synthesizes a single composite range key ("field#field") for
// any model with a 3-part identifier — confirmed against the deployed
// GearListing table (`reportCode` HASH, `fightId#characterName` RANGE).
// Direct DynamoDB writes have to set that attribute explicitly alongside
// the plain fields, since there's no VTL resolver here to derive it.
function compositeSortKey(fightId: string, characterName: string): string {
  return `${fightId}#${characterName}`;
}

// DEATHRECORD read via cast for the same generated-env-types gap
// documented at loadGearIssueRefData's GEMQUALITY read.
const THREE_FIELD_CHILD_TABLE_NAMES = [
  env.TABLE_NAME_GEARLISTING,
  env.TABLE_NAME_GEARISSUE,
  env.TABLE_NAME_CONSUMABLESCORE,
  env.TABLE_NAME_DRUMSTAT,
  env.TABLE_NAME_SHADOWRESISTANCERESULT,
  (env as unknown as Record<string, string>).TABLE_NAME_DEATHRECORD,
  (env as unknown as Record<string, string>).TABLE_NAME_DAMAGESTAT,
] as const;

// Re-ingesting the same report/fight (e.g. after a correction) should
// replace prior results rather than error on duplicate keys.
async function clearExistingChildRows(reportCode: string, fightId: string) {
  for (const tableName of THREE_FIELD_CHILD_TABLE_NAMES) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'reportCode = :reportCode AND begins_with(#sk, :fightIdPrefix)',
        ExpressionAttributeNames: { '#sk': 'fightId#characterName' },
        ExpressionAttributeValues: {
          ':reportCode': reportCode,
          ':fightIdPrefix': `${fightId}#`,
        },
      })
    );
    await Promise.all(
      (res.Items ?? []).map((item) =>
        ddb.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { reportCode, 'fightId#characterName': item['fightId#characterName'] },
          })
        )
      )
    );
  }
}

function toSourceUrl(baseUrl: string, reportCode: string, fightId: string): string {
  const siteRoot = baseUrl.replace(/\/v1\/?$/, '');
  return `${siteRoot}/reports/${reportCode}#fight=${fightId}`;
}

interface ProcessFightInfo {
  fightId: string;
  encounterName: string;
  isBossEncounter: boolean;
  kill: boolean | null;
  encounterGroupKey: string | null;
}

// `fight` supplies the time window (start_time/end_time) and zone — for a
// merged trash group this is a synthetic fight spanning the whole gap, not
// a real single WCL fight, which is fine: every WCL call here is windowed
// by start_time/end_time alone. `info` carries what groupEncounters()
// already decided (fightId/name/boss-vs-trash/kill/group key) rather than
// re-deriving any of it from `fight.boss`, which is not a reliable signal
// on its own (see groupEncounters.ts).
async function processFight(
  fight: WclFight,
  info: ProcessFightInfo,
  ctx: {
    reportCode: string;
    resolvedBaseUrl: string;
    reportTitle: string;
    reportStart: number;
    actorIdToName: Map<number, string>;
    gearRefData: GearIssueRefData;
    consumableRefData: ReturnType<typeof buildConsumableRefData>;
    srItemValues: Map<number, number>;
    srEnchantValues: Map<number, { srValue: number; name: string }>;
    raceByName: Map<string, string>;
    now: string;
  }
) {
  const { reportCode, resolvedBaseUrl, reportTitle, reportStart, actorIdToName, gearRefData, consumableRefData, srItemValues, srEnchantValues, raceByName, now } =
    ctx;
  const { fightId, encounterName, isBossEncounter, kill, encounterGroupKey } = info;

  const summary = await invokeWclClient<SummaryTableResponse>({
    action: 'getSummaryTable',
    reportCode,
    start: fight.start_time,
    end: fight.end_time,
    baseUrl: resolvedBaseUrl,
  });

  // Role comes from which playerDetails bucket WCL put the player in —
  // there's no explicit role field on the player entries themselves.
  const characters = [
    ...(summary.playerDetails.tanks ?? []).map((c) => ({ ...c, role: 'tank' })),
    ...(summary.playerDetails.healers ?? []).map((c) => ({ ...c, role: 'healer' })),
    ...(summary.playerDetails.dps ?? []).map((c) => ({ ...c, role: 'dps' })),
  ];

  // WCL sometimes returns gear with no `name` on any item (see the
  // marshalling note on the document client). Backfill from the ItemName
  // reference table so the Gear Listing/Issues tabs stay usable — the ids
  // are always present, only the names go missing.
  await backfillItemNames(characters.flatMap((c) => c.combatantInfo?.gear ?? []));

  // Damage is only meaningful for boss encounters (trash isn't listed in
  // the UI). Fetched here, ahead of the clear below, so a WCL failure aborts
  // before any existing rows are destroyed.
  const damageTable = isBossEncounter
    ? await invokeWclClient<DamageTableResponse>({
        action: 'getTable',
        view: 'damage-done',
        reportCode,
        start: fight.start_time,
        end: fight.end_time,
        baseUrl: resolvedBaseUrl,
      })
    : null;

  // This used to run AFTER the clear below, so a WCL failure here (a 429
  // during a bulk re-ingest) left the fight with its old rows deleted and
  // nothing written for drums or damage. Fetched first, like everything
  // else that can fail.
  // Drums: one cast-events + one applybuff-events fetch for the whole
  // fight (not per player — cast/apply timestamps within the fight window
  // give exact per-drummer, per-cast target attribution on their own).
  const [castEvents, applyBuffEvents] = await Promise.all([
    invokeWclClient<EventsResponse<WclCastEvent>>({
      action: 'getEvents',
      reportCode,
      start: fight.start_time,
      end: fight.end_time,
      filter: 'type="cast"',
      baseUrl: resolvedBaseUrl,
    }),
    invokeWclClient<EventsResponse<WclApplyBuffEvent>>({
      action: 'getEvents',
      reportCode,
      start: fight.start_time,
      end: fight.end_time,
      filter: 'type="applybuff"',
      baseUrl: resolvedBaseUrl,
    }),
  ]);

  // Every fallible WCL fetch is done up front, before anything is deleted.
  // This used to interleave — rows were cleared first, then each character's
  // buffs were fetched — so a mid-fight 429 left the fight stripped of its
  // old rows with nothing to replace them. One report lost 371 gear rows and
  // 115 death records that way during a bulk re-ingest. Fetch first, delete
  // second: a failure here now aborts before anything is destroyed.
  const perCharacter = await Promise.all(
    characters.map(async (character) => {
      // Per-player buff presence (elixirs/flasks/food/scrolls/Shadow
      // Protection) — the `buffs` table view reports uptime for buffs
      // already active at the window's start, unlike raw events (see
      // consumables.ts / shadowResistance.ts for why that distinction
      // matters). Confirmed live: without a targetid filter this endpoint
      // returns whole-report aggregate uptime with no per-actor breakdown
      // at all, so a per-character call is structurally required — there's
      // no bulk-fetch shortcut here, which is exactly why WCL concurrency
      // is bounded globally instead.
      const buffsTable = await invokeWclClient<BuffsTableResponse>({
        action: 'getTable',
        view: 'buffs',
        reportCode,
        start: fight.start_time,
        end: fight.end_time,
        extraParams: { targetid: character.id },
        baseUrl: resolvedBaseUrl,
      });
      return { character, playerBuffGuids: new Set(buffsTable.auras.map((a) => a.guid)) };
    })
  );

  await clearExistingChildRows(reportCode, fightId);

  // Amplify Data's generated GraphQL schema declares `createdAt`/`updatedAt`
  // as non-nullable on every model (its own auto-managed timestamps,
  // normally set by AppSync's resolvers). Writing straight to DynamoDB
  // bypasses those resolvers, so these have to be set explicitly here or
  // every read through AppSync fails schema validation on the whole
  // response, not just the missing field.
  await Promise.all(
    perCharacter.map(async ({ character, playerBuffGuids }) => {
      const gear = character.combatantInfo?.gear ?? [];
      const sortKey = compositeSortKey(fightId, character.name);

      // a.json() (AWSJSON) fields must be stored as the *native* DynamoDB
      // structure (List/Map), not a pre-stringified string — AppSync's own
      // resolver does exactly one JSON-encoding pass over whatever's
      // stored to build the wire response. Pre-stringifying here caused
      // that encoding to run on an already-JSON string, doubling it up
      // (confirmed by inspecting the raw GraphQL response body directly).
      await ddb.send(
        new PutCommand({
          TableName: env.TABLE_NAME_GEARLISTING,
          Item: {
            reportCode,
            fightId,
            characterName: character.name,
            'fightId#characterName': sortKey,
            gear,
            characterClass: character.type ?? null,
            spec: character.specs?.[0] ?? null,
            role: character.role,
            createdAt: now,
            updatedAt: now,
          },
        })
      );
      await ddb.send(
        new PutCommand({
          TableName: env.TABLE_NAME_GEARISSUE,
          Item: {
            reportCode,
            fightId,
            characterName: character.name,
            'fightId#characterName': sortKey,
            issues: analyzeGear(gear, gearRefData),
            createdAt: now,
            updatedAt: now,
          },
        })
      );

      const consumables = analyzeConsumables(gear, playerBuffGuids, consumableRefData);
      await ddb.send(
        new PutCommand({
          TableName: env.TABLE_NAME_CONSUMABLESCORE,
          Item: {
            reportCode,
            fightId,
            characterName: character.name,
            'fightId#characterName': sortKey,
            score: consumables.score,
            battleElixir: consumables.battleElixir,
            guardianElixir: consumables.guardianElixir,
            flask: consumables.flask,
            food: consumables.food,
            scroll: consumables.scroll,
            weaponEnhancement: consumables.weaponEnhancement,
            potionUse: character.potionUse ?? 0,
            healthstoneUse: character.healthstoneUse ?? 0,
            createdAt: now,
            updatedAt: now,
          },
        })
      );

      const sr = analyzeShadowResistance(
        gear,
        srItemValues,
        srEnchantValues,
        playerBuffGuids,
        raceByName.get(character.name)
      );
      await ddb.send(
        new PutCommand({
          TableName: env.TABLE_NAME_SHADOWRESISTANCERESULT,
          Item: {
            reportCode,
            fightId,
            characterName: character.name,
            'fightId#characterName': sortKey,
            srFromGear: sr.srFromGear,
            srFromBuffsAndRace: sr.srFromBuffsAndRace,
            srTotal: sr.srTotal,
            gearNotes: sr.gearNotes,
            unmappedResistEnchants: sr.unmappedResistEnchants,
            createdAt: now,
            updatedAt: now,
          },
        })
      );
    })
  );

  // Deaths: the summary table's deathEvents, grouped per character — a
  // list per row because battle-rez means one character can die more than
  // once in a single pull. deathTime is ms relative to the fight window.
  const deathsByCharacter = new Map<string, Array<{ timeMs: number; abilityName: string | null }>>();
  for (const death of summary.deathEvents ?? []) {
    const existing = deathsByCharacter.get(death.name);
    const entry = { timeMs: death.deathTime, abilityName: death.ability?.name ?? null };
    if (existing) existing.push(entry);
    else deathsByCharacter.set(death.name, [entry]);
  }
  await Promise.all(
    Array.from(deathsByCharacter.entries()).map(([characterName, deaths]) =>
      ddb.send(
        new PutCommand({
          TableName: (env as unknown as Record<string, string>).TABLE_NAME_DEATHRECORD,
          Item: {
            reportCode,
            fightId,
            characterName,
            'fightId#characterName': compositeSortKey(fightId, characterName),
            deaths,
            createdAt: now,
            updatedAt: now,
          },
        })
      )
    )
  );

  // Drum events were fetched up front (see above); only the analysis and
  // writes happen here.
  const drumStats = analyzeDrums(castEvents.events, applyBuffEvents.events, actorIdToName);

  await Promise.all(
    drumStats.map((stat) => {
      const sortKey = compositeSortKey(fightId, stat.characterName);
      return ddb.send(
        new PutCommand({
          TableName: env.TABLE_NAME_DRUMSTAT,
          Item: {
            reportCode,
            fightId,
            characterName: stat.characterName,
            'fightId#characterName': sortKey,
            totalDrums: stat.totalDrums,
            buffsPerDrum: stat.buffsPerDrum,
            weightedScore: Math.round(stat.buffsPerDrum * stat.totalDrums),
            pointlessCasts: stat.pointlessCasts,
            createdAt: now,
            updatedAt: now,
          },
        })
      );
    })
  );

  if (damageTable) {
    const damageStats = analyzeDamage(damageTable, fight.end_time - fight.start_time);
    await Promise.all(
      damageStats.map((stat) =>
        ddb.send(
          new PutCommand({
            TableName: (env as unknown as Record<string, string>).TABLE_NAME_DAMAGESTAT,
            Item: {
              reportCode,
              fightId,
              characterName: stat.characterName,
              'fightId#characterName': compositeSortKey(fightId, stat.characterName),
              totalDamage: stat.totalDamage,
              dps: stat.dps,
              activeTimeMs: stat.activeTimeMs,
              pctOfRaid: stat.pctOfRaid,
              createdAt: now,
              updatedAt: now,
            },
          })
        )
      )
    );
  }

  const fightDate = new Date(reportStart + fight.start_time).toISOString();
  const durationSeconds = Math.round((fight.end_time - fight.start_time) / 1000);

  const reportItem = {
    reportCode,
    fightId,
    title: reportTitle,
    zone: fight.zoneName,
    fightDate,
    durationSeconds,
    sourceUrl: toSourceUrl(resolvedBaseUrl, reportCode, fightId),
    encounterName,
    isBossEncounter,
    kill,
    encounterGroupKey,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: env.TABLE_NAME_REPORT, Item: reportItem }));

  return reportItem;
}

interface FightRankingsResponse {
  fightID: number;
  roles?: Partial<Record<'tanks' | 'healers' | 'dps', { characters?: Array<{ name: string; rankPercent?: number | null }> }>>;
}

// Parse percentiles come from WCL v2's per-fight report rankings — what the
// WCL site itself shows for a fight. (v1's /parses/character returns only an
// incomplete subset of a character's kills, which is why this moved to v2.)
// One GraphQL call covers every kill in the report.
//
// Only ranked kills carry a percentile, and hidden characters come back with
// none — both simply leave parsePercent unset.
//
// Strictly best-effort: a failure here must never fail the ingest, and a
// later re-ingest fills in anything WCL had not ranked yet.
async function attachParsePercentiles(args: {
  reportCode: string;
  resolvedBaseUrl: string;
  killFightIds: Set<string>;
  now: string;
}) {
  const { reportCode, resolvedBaseUrl, killFightIds, now } = args;
  if (killFightIds.size === 0) return;
  const damageTable = (env as unknown as Record<string, string>).TABLE_NAME_DAMAGESTAT;

  const rankings = await invokeWclClient<FightRankingsResponse[]>({
    action: 'getFightRankings',
    reportCode,
    fightIds: Array.from(killFightIds).map(Number),
    baseUrl: resolvedBaseUrl,
  });

  const rows = (
    await ddb.send(
      new QueryCommand({
        TableName: damageTable,
        KeyConditionExpression: 'reportCode = :reportCode',
        ExpressionAttributeValues: { ':reportCode': reportCode },
      })
    )
  ).Items ?? [];
  const byKey = new Map(rows.map((r) => [`${r.fightId}#${r.characterName}`, r]));

  const updates: Array<{ key: unknown; percent: number }> = [];
  for (const fight of rankings) {
    for (const role of Object.values(fight.roles ?? {})) {
      for (const c of role?.characters ?? []) {
        if (typeof c.rankPercent !== 'number') continue;
        const row = byKey.get(`${fight.fightID}#${c.name}`);
        if (!row) continue;
        updates.push({
          key: { reportCode, 'fightId#characterName': row['fightId#characterName'] },
          percent: Math.round(c.rankPercent * 10) / 10,
        });
      }
    }
  }

  const BATCH = 25;
  for (let i = 0; i < updates.length; i += BATCH) {
    await Promise.all(
      updates.slice(i, i + BATCH).map((u) =>
        ddb.send(
          new UpdateCommand({
            TableName: damageTable,
            Key: u.key as Record<string, unknown>,
            UpdateExpression: 'SET parsePercent = :p, updatedAt = :now',
            ExpressionAttributeValues: { ':p': u.percent, ':now': now },
          })
        )
      )
    );
  }
}

interface FightCritResult {
  name: string | null;
  amount: number;
  ability: string | null;
}

// Highest crit damage and crit heal per boss fight, for the Hall of Records. One
// wcl-client call (WCL v2) covers every fight of the report — 0 extra v1 calls.
// Each record is stamped with the boss and the fight's date so the sidebar can
// show "on <boss>" and when without any further lookup.
async function collectFightCrits(args: {
  reportCode: string;
  resolvedBaseUrl: string;
  fights: Array<{ fightId: string; encounterName: string; fightDate: string | null }>;
}): Promise<Record<string, FightCritEntry>> {
  const { reportCode, resolvedBaseUrl, fights } = args;
  const ids = fights.map((f) => Number(f.fightId)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return {};
  const res = await invokeWclClient<{
    damage: Record<string, FightCritResult>;
    healing: Record<string, FightCritResult>;
  }>({ action: 'getFightCrits', reportCode, fightIds: ids, baseUrl: resolvedBaseUrl });

  const meta = new Map(fights.map((f) => [f.fightId, f]));
  const out: Record<string, FightCritEntry> = {};
  for (const kind of ['damage', 'healing'] as const) {
    for (const [fightId, c] of Object.entries(res[kind] ?? {})) {
      const m = meta.get(fightId);
      if (!m) continue;
      (out[fightId] ??= {})[kind] = {
        name: c.name,
        amount: c.amount,
        ability: c.ability,
        boss: m.encounterName,
        fightId,
        at: m.fightDate,
      };
    }
  }
  return out;
}

const raidNightTables = (): RaidNightTables => ({
  report: env.TABLE_NAME_REPORT,
  raidNight: (env as unknown as Record<string, string>).TABLE_NAME_RAIDNIGHT,
  deathRecord: (env as unknown as Record<string, string>).TABLE_NAME_DEATHRECORD,
  gearListing: env.TABLE_NAME_GEARLISTING,
});

export const handler = async (event: {
  reportCode: string;
  baseUrl?: string;
  parsesOnly?: boolean;
  raidNightOnly?: boolean;
  critsOnly?: boolean;
}) => {
  const { reportCode } = event;
  const resolvedBaseUrl = event.baseUrl ?? env.WCL_DEFAULT_BASE_URL;

  // Rebuilds the list-summary row from stored Report rows alone — no WCL
  // calls, so a bulk backfill spends none of the request budget.
  if (event.raidNightOnly) {
    await recomputeRaidNight(ddb, raidNightTables(), reportCode);
    return { reportCode, raidNightOnly: true };
  }

  // Refreshes only the Hall of Records crit records: reads the fight list from
  // stored Report rows and makes WCL v2 calls alone — no v1 calls at all, so a
  // bulk run spends none of the v1 budget. Errors propagate so a backfill is loud.
  if (event.critsOnly) {
    const reportRows = (
      await ddb.send(
        new QueryCommand({
          TableName: env.TABLE_NAME_REPORT,
          KeyConditionExpression: 'reportCode = :reportCode',
          ExpressionAttributeValues: { ':reportCode': reportCode },
        })
      )
    ).Items ?? [];
    const fights = reportRows
      .filter((r) => r.isBossEncounter && r.durationSeconds)
      .map((r) => ({
        fightId: String(r.fightId),
        encounterName: String(r.encounterName ?? ''),
        fightDate: (r.fightDate as string | undefined) ?? null,
      }));
    const critByFight = await collectFightCrits({ reportCode, resolvedBaseUrl, fights });
    await recomputeRaidNight(ddb, raidNightTables(), reportCode, { critByFight });
    return { reportCode, critsOnly: true, fightsConsidered: fights.length, fightsWithCrits: Object.keys(critByFight).length };
  }

  // Refreshes parse percentiles from rows already stored, without touching
  // v1 at all (so it costs none of the v1 request budget a full re-ingest
  // does). For kills WCL had not ranked yet at ingest time, or after a
  // change to how parses are sourced.
  if (event.parsesOnly) {
    const reportRows = (
      await ddb.send(
        new QueryCommand({
          TableName: env.TABLE_NAME_REPORT,
          KeyConditionExpression: 'reportCode = :reportCode',
          ExpressionAttributeValues: { ':reportCode': reportCode },
        })
      )
    ).Items ?? [];
    const killFightIds = new Set(
      reportRows.filter((r) => r.isBossEncounter && r.kill && r.durationSeconds).map((r) => String(r.fightId))
    );
    await attachParsePercentiles({ reportCode, resolvedBaseUrl, killFightIds, now: new Date().toISOString() });
    return { reportCode, parsesOnly: true, killsConsidered: killFightIds.size };
  }

  const reportFights = await invokeWclClient<ReportFightsResponse>({
    action: 'getReportFights',
    reportCode,
    baseUrl: resolvedBaseUrl,
  });

  const [gearRefData, consumableBuffRows, srItemRows, srEnchantRows, raceRows, rules] = await Promise.all([
    loadGearIssueRefData(),
    scanAll<ConsumableBuffRow>(env.TABLE_NAME_CONSUMABLEBUFF),
    scanAll<{ itemId: number; srValue: number }>(env.TABLE_NAME_SHADOWRESISTANCEITEM),
    scanAll<{ enchantId: number; srValue: number; name: string }>(
      (env as unknown as Record<string, string>).TABLE_NAME_SHADOWRESISTANCEENCHANT
    ),
    scanAll<{ characterName: string; race: string }>(
      (env as unknown as Record<string, string>).TABLE_NAME_CHARACTERRACE
    ),
    scanAll<RaidValidationRuleRow>(env.TABLE_NAME_RAIDVALIDATIONRULE),
  ]);
  const consumableRefData = buildConsumableRefData(consumableBuffRows);
  const srItemValues = new Map(srItemRows.map((s) => [s.itemId, s.srValue]));
  const srEnchantValues = new Map(srEnchantRows.map((e) => [e.enchantId, { srValue: e.srValue, name: e.name }]));
  const raceByName = new Map(raceRows.map((r) => [r.characterName, r.race]));

  const actorIdToName = new Map(reportFights.friendlies.map((f) => [f.id, f.name]));
  const now = new Date().toISOString();

  const ctx = {
    reportCode,
    resolvedBaseUrl,
    reportTitle: reportFights.title,
    reportStart: reportFights.start,
    actorIdToName,
    gearRefData,
    consumableRefData,
    srItemValues,
    srEnchantValues,
    raceByName,
    now,
  };

  // A run of adjacent same-named fights is a boss encounter if any attempt
  // in it landed a kill (boss!=0). See groupEncounters.ts for why this
  // deliberately does NOT also cross-reference RaidValidationRule.bossName.
  const groups = groupEncounters(reportFights.fights);

  const tasks: Array<{ fight: WclFight; info: ProcessFightInfo }> = [];
  for (const group of groups) {
    if (group.kind === 'boss') {
      // Each attempt (wipe or kill) stays its own row, tagged with a
      // shared encounterGroupKey so the frontend can group them.
      for (const fight of group.fights) {
        tasks.push({
          fight,
          info: {
            fightId: String(fight.id),
            encounterName: group.name,
            isBossEncounter: true,
            kill: fight.kill ?? false,
            encounterGroupKey: group.name,
          },
        });
      }
    } else {
      // All trash between two boss encounters collapses into one
      // combined-window row — a synthetic fight spanning from the first
      // pull's start to the last pull's end, reusing the exact same
      // per-fight processing (every WCL call here is windowed by
      // start_time/end_time alone, so this needs no special-casing).
      const first = group.fights[0];
      const last = group.fights[group.fights.length - 1];
      const synthetic: WclFight = {
        id: first.id,
        name: group.name,
        start_time: first.start_time,
        end_time: last.end_time,
        zoneID: first.zoneID,
        zoneName: first.zoneName,
        boss: 0,
      };
      tasks.push({
        fight: synthetic,
        info: {
          fightId: `trash-${first.id}-${last.id}`,
          encounterName: group.name,
          isBossEncounter: false,
          kill: null,
          encounterGroupKey: null,
        },
      });
    }
  }

  // Every task is processed independently (its own clear-then-write), so
  // one bad fight/gap doesn't have to block the rest of the raid night
  // from ingesting — logged and skipped rather than thrown.
  const results = await Promise.allSettled(tasks.map(({ fight, info }) => processFight(fight, info, ctx)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const failure of failures) {
    console.error('Failed to process fight:', failure.reason);
  }

  try {
    await attachParsePercentiles({
      reportCode,
      resolvedBaseUrl,
      killFightIds: new Set(tasks.filter((t) => t.info.isBossEncounter && t.info.kill).map((t) => t.info.fightId)),
      now,
    });
  } catch (err) {
    console.warn('Parse attachment skipped:', err);
  }

  // Summary row for the Raid Reports list. Derived from whatever Report rows
  // now exist, so a partial ingest still yields a correct row. Best-effort:
  // the list is a convenience over data that is already safely stored.
  // Crit records come from WCL (v2), so they are fetched separately and
  // best-effort: a failure there must not lose the rest of the summary, and
  // recomputeRaidNight carries the previous crit records forward.
  let critByFight: Record<string, FightCritEntry> | undefined;
  try {
    critByFight = await collectFightCrits({
      reportCode,
      resolvedBaseUrl,
      fights: tasks
        .filter((t) => t.info.isBossEncounter && Math.round((t.fight.end_time - t.fight.start_time) / 1000) > 0)
        .map((t) => ({
          fightId: t.info.fightId,
          encounterName: t.info.encounterName,
          fightDate: new Date(reportFights.start + t.fight.start_time).toISOString(),
        })),
    });
  } catch (err) {
    console.warn('Crit records skipped:', err);
  }
  try {
    await recomputeRaidNight(ddb, raidNightTables(), reportCode, critByFight ? { critByFight } : undefined);
  } catch (err) {
    console.warn('RaidNight summary skipped:', err);
  }

  // Recorded so a partial ingest is visible to the admin who ran it rather
  // than only in CloudWatch — a failed encounter simply never appears in
  // the reports list, which reads identically to "this raid had no bosses".
  await ddb.send(
    new PutCommand({
      TableName: (env as unknown as Record<string, string>).TABLE_NAME_INGESTSTATUS,
      Item: {
        reportCode,
        finishedAt: new Date().toISOString(),
        encountersTotal: tasks.length,
        encountersFailed: failures.length,
        errors: failures.slice(0, 10).map((f) => String(f.reason?.message ?? f.reason)),
        createdAt: now,
        updatedAt: now,
      },
    })
  );

  // Log validity is a property of the whole report (enough boss/trash
  // kills across the raid night), so this is written once here — not once
  // per encounter — using reportFights.fights/enemies directly (validation
  // counts every real WCL fight regardless of how they're grouped above).
  const outcome = validateReport(reportFights.fights, reportFights.enemies, rules);
  if (outcome) {
    await ddb.send(
      new PutCommand({
        TableName: env.TABLE_NAME_VALIDATIONRESULT,
        Item: {
          reportCode,
          zone: outcome.zone,
          isValid: outcome.isValid,
          bossesRequired: outcome.bossesRequired,
          bossesKilled: outcome.bossesKilled,
          details: outcome.details,
          createdAt: now,
          updatedAt: now,
        },
      })
    );
  }

  return {
    reportCode,
    encountersProcessed: results.length - failures.length,
    encountersFailed: failures.length,
  };
};
