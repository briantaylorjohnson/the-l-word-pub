/**
 * Warcraft Logs adapter — the only code in the backend that knows WCL's API shapes.
 *
 * Two APIs live here:
 *  - v1 REST: report data (fights, tables, events). GETs with the API key as a query
 *    param (v1's auth scheme — no OAuth, no redirect URI).
 *  - v2 GraphQL (OAuth client credentials): per-fight parse rankings and per-fight crit
 *    records. v2 is used only where v1 falls short — v1's /parses endpoint returns an
 *    incomplete subset of a character's kills — and it has its own request budget, so it
 *    never competes with v1 ingest calls.
 *
 * Invoke shape (see WclClientEvent below) is deliberately generic/action-
 * dispatched rather than one Lambda per WCL endpoint, since these are all
 * thin passthroughs used together by ingestReport (task 5) — splitting
 * them into separate functions would just add cold-start overhead for no
 * isolation benefit.
 */

const WCL_API_KEY = process.env.WCL_API_KEY!;
const DEFAULT_BASE_URL = process.env.WCL_DEFAULT_BASE_URL ?? 'https://classic.warcraftlogs.com/v1';

export interface WclFight {
  id: number;
  name: string;
  start_time: number;
  end_time: number;
  kill?: boolean;
  difficulty?: number;
  zoneID?: number;
  zoneName?: string;
  boss?: number;
}

export interface WclFriendly {
  name: string;
  id: number;
  guid: number;
  type: string;
}

// `guid` is the enemy's real NPC template ID (matches RaidValidationRule's
// npcIds); `fights[].instances` is how many copies of this enemy appeared
// in that specific fight — the basis for the validate.ts kill-count check.
export interface WclEnemy {
  name: string;
  id: number;
  guid: number;
  type: string;
  fights: Array<{ id: number; instances?: number }>;
}

export interface ReportFightsResponse {
  title: string;
  start: number;
  end: number;
  zone: number;
  lang: string;
  // Present on classic logs; each character's home realm, which the parses
  // endpoint needs (a guild log can include cross-realm raiders).
  exportedCharacters?: Array<{ name: string; server: string; region: string }>;
  fights: WclFight[];
  friendlies: WclFriendly[];
  enemies: WclEnemy[];
}

async function wclGet<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set('api_key', WCL_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WCL API ${path} failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function getReportFights(baseUrl: string, reportCode: string) {
  return wclGet<ReportFightsResponse>(baseUrl, `/report/fights/${reportCode}`, {});
}

// The "summary" table view carries each player's talents and combatantInfo
// (gear array) for the requested time window — the source for GearListing.
export async function getSummaryTable(baseUrl: string, reportCode: string, start: number, end: number) {
  return wclGet<unknown>(baseUrl, `/report/tables/summary/${reportCode}`, { start, end });
}

// Generic table view (buffs/casts/damage-done/healing/etc). Table views
// report aggregated uptime/counts across the window — unlike raw events,
// a buff already active before `start` still shows up, which matters for
// consumables (elixirs/flasks/food are almost always applied before the
// pull, not during it).
export async function getTable(
  baseUrl: string,
  view: string,
  reportCode: string,
  start: number,
  end: number,
  extraParams?: Record<string, string | number | undefined>
) {
  return wclGet<unknown>(baseUrl, `/report/tables/${view}/${reportCode}`, { start, end, ...extraParams });
}

// A character's ranked parses for one encounter, newest first. This is the
// only v1 source of parse percentiles — report tables carry none — so the
// worker matches rows back to a fight on reportID/fightID. Only kills that
// WCL has ranked appear here.
export async function getParses(
  baseUrl: string,
  characterName: string,
  serverSlug: string,
  region: string,
  extraParams?: Record<string, string | number | undefined>
) {
  const path = `/parses/character/${encodeURIComponent(characterName)}/${encodeURIComponent(serverSlug)}/${encodeURIComponent(region)}`;
  return wclGet<unknown>(baseUrl, path, extraParams ?? {});
}

// ---------------------------------------------------------------------------
// WCL v2 (GraphQL + OAuth client-credentials).
//
// Only used for per-fight rankings: v1 has no per-fight parse, and its
// /parses/character endpoint returns an incomplete subset of a character's
// kills. v2's report `rankings` field is what the WCL site itself shows for
// a fight. Everything else stays on v1.
// ---------------------------------------------------------------------------

const WCL_CLIENT_ID = process.env.WCL_CLIENT_ID;
const WCL_CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;

// A client-credentials token lasts ~a year, but nothing here assumes that:
// it is cached for the life of the warm container and re-fetched on expiry
// or on a 401, so a rotated secret or a cold start just costs one request.
let cachedToken: { value: string; expiresAt: number } | null = null;

function siteRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

async function getV2Token(root: string, forceRefresh = false): Promise<string> {
  if (!WCL_CLIENT_ID || !WCL_CLIENT_SECRET) {
    throw new Error('WCL v2 credentials are not configured (WCL_CLIENT_ID / WCL_CLIENT_SECRET)');
  }
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;

  const res = await fetch(`${root}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${WCL_CLIENT_ID}:${WCL_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WCL OAuth token request failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function wclGraphql<T>(root: string, query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getV2Token(root, attempt > 0);
    const res = await fetch(`${root}/api/v2/client`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && attempt === 0) continue; // stale token — refresh once
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WCL v2 GraphQL failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(`WCL v2 GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data as T;
  }
  throw new Error('WCL v2 authentication failed');
}

export interface FightRankingCharacter {
  name: string;
  class?: string;
  rankPercent?: number | null;
  bracketPercent?: number | null;
  amount?: number;
}

export interface FightRanking {
  fightID: number;
  roles?: Partial<Record<'tanks' | 'healers' | 'dps', { characters?: FightRankingCharacter[] }>>;
}

// Per-fight DPS rankings for the given fights of one report, in one call.
// rankPercent is the parse. `rankings` is a JSON scalar, so it comes back
// untyped and is narrowed here rather than trusted downstream.
export async function getFightRankings(baseUrl: string, reportCode: string, fightIds: number[]) {
  const data = await wclGraphql<{ reportData: { report: { rankings: unknown } | null } }>(
    siteRoot(baseUrl),
    `query FightRankings($code: String!, $fightIDs: [Int]) {
       reportData { report(code: $code) { rankings(fightIDs: $fightIDs, playerMetric: dps) } }
     }`,
    { code: reportCode, fightIDs: fightIds }
  );
  const raw = data.reportData.report?.rankings as { data?: FightRanking[] } | FightRanking[] | undefined;
  return (Array.isArray(raw) ? raw : (raw?.data ?? [])) as FightRanking[];
}

export interface FightCrit {
  /** Resolved player name (null if the actor could not be resolved). */
  name: string | null;
  sourceID: number;
  /** Damage: the hit. Healing: gross heal (effective + overheal) — the number the healer saw. */
  amount: number;
  /** Healing only: the overhealing part of `amount`. */
  overheal?: number;
  ability: string | null;
  /** Report-relative ms of the event. */
  timestamp: number;
}

export interface FightCritsResponse {
  damage: Record<string, FightCrit>;
  healing: Record<string, FightCrit>;
}

// Highest single critical hit and highest single critical heal per fight, for
// the Hall of Records. Uses v2 `report.events` because it can filter to crits
// server-side and cover every boss fight of a report in one query (v1 would need
// a call per fight), and v2 has its own request budget (9,000 points/hour; each
// of these queries costs ~1), so it never competes with v1 ingest calls.
//
// Pages internally on `nextPageTimestamp` — a whole night of crit damage is
// ~5,000 events and does not fit one page — and returns only the per-fight
// winners, so the Lambda response stays tiny.
//
// Players only (`source.type = "Player"`, so no pets). v2 DamageDone already
// excludes friendly fire, so no hostile-target filter is needed (verified: a
// `target.type = "Player"` filter returns 0 events).
const CRIT_FILTER = 'isCritical = true and source.type = "Player"';

// WCL's `isCritical` also matches events that are not real crits, so heals that
// cannot critically strike in TBC would otherwise take the record (Lay on Hands
// showed up as a 26,966 "crit" on 2026-11-10). Healing events from these
// abilities are ignored; add to the pattern if another one turns up.
const NON_CRITTING_HEAL = /^(Lay on Hands|Judgement of Light|Vampiric (Touch|Embrace))$|healthstone|healing potion|rejuvenation potion/i;
const CRIT_QUERY = `query FightCrits($code: String!, $ids: [Int], $dt: EventDataType, $start: Float, $actors: Boolean!) {
  reportData { report(code: $code) {
    events(fightIDs: $ids, dataType: $dt, filterExpression: "${CRIT_FILTER.replace(/"/g, '\\"')}", startTime: $start, limit: 10000, useAbilityIDs: false) {
      data nextPageTimestamp
    }
    masterData @include(if: $actors) { actors(type: "Player") { id name } }
  } }
}`;

interface CritEvent {
  fight: number;
  sourceID: number;
  amount?: number;
  overheal?: number;
  timestamp: number;
  ability?: { name?: string } | null;
}

export async function getFightCrits(baseUrl: string, reportCode: string, fightIds: number[]): Promise<FightCritsResponse> {
  const root = siteRoot(baseUrl);
  const names = new Map<number, string>();
  const out: FightCritsResponse = { damage: {}, healing: {} };
  if (fightIds.length === 0) return out;

  for (const [key, dataType] of [
    ['damage', 'DamageDone'],
    ['healing', 'Healing'],
  ] as const) {
    let start: number | null = null;
    for (let page = 0; page < 50; page++) {
      const data: {
        reportData: {
          report: {
            events: { data: CritEvent[]; nextPageTimestamp: number | null };
            masterData?: { actors: Array<{ id: number; name: string }> };
          } | null;
        };
      } = await wclGraphql(root, CRIT_QUERY, {
        code: reportCode,
        ids: fightIds,
        dt: dataType,
        start,
        actors: names.size === 0,
      });
      const report = data.reportData.report;
      if (!report) throw new Error(`WCL v2: report ${reportCode} not found`);
      for (const a of report.masterData?.actors ?? []) names.set(a.id, a.name);

      for (const e of report.events.data) {
        if (key === 'healing' && e.ability?.name && NON_CRITTING_HEAL.test(e.ability.name)) continue;
        const gross = key === 'healing' ? (e.amount ?? 0) + (e.overheal ?? 0) : (e.amount ?? 0);
        const fightKey = String(e.fight);
        const current = out[key][fightKey];
        if (!current || gross > current.amount) {
          out[key][fightKey] = {
            name: names.get(e.sourceID) ?? null,
            sourceID: e.sourceID,
            amount: gross,
            ...(key === 'healing' ? { overheal: e.overheal ?? 0 } : {}),
            ability: e.ability?.name ?? null,
            timestamp: e.timestamp,
          };
        }
      }
      if (report.events.nextPageTimestamp == null) break;
      start = report.events.nextPageTimestamp;
    }
  }
  // Names may have arrived after an earlier page's winner was recorded.
  for (const group of [out.damage, out.healing]) {
    for (const c of Object.values(group)) if (c.name === null) c.name = names.get(c.sourceID) ?? null;
  }
  return out;
}

// Raw events (casts/buffs/debuffs) for the consumable and drum-efficiency
// rules — those need per-cast target counts, not just aggregate tables.
// extraParams passes through WCL's native sourceid/targetid/abilityid GET
// params, which are separate from (and more reliable than) the `filter`
// query-language string.
export async function getEvents(
  baseUrl: string,
  reportCode: string,
  start: number,
  end: number,
  filter?: string,
  extraParams?: Record<string, string | number | undefined>
) {
  return wclGet<unknown>(baseUrl, `/report/events/${reportCode}`, { start, end, filter, ...extraParams });
}

export type WclClientEvent =
  | { action: 'getReportFights'; reportCode: string; baseUrl?: string }
  | { action: 'getSummaryTable'; reportCode: string; start: number; end: number; baseUrl?: string }
  | {
      action: 'getEvents';
      reportCode: string;
      start: number;
      end: number;
      filter?: string;
      extraParams?: Record<string, string | number | undefined>;
      baseUrl?: string;
    }
  | {
      action: 'getTable';
      view: string;
      reportCode: string;
      start: number;
      end: number;
      extraParams?: Record<string, string | number | undefined>;
      baseUrl?: string;
    }
  | { action: 'getFightRankings'; reportCode: string; fightIds: number[]; baseUrl?: string }
  | { action: 'getFightCrits'; reportCode: string; fightIds: number[]; baseUrl?: string }
  | {
      action: 'getParses';
      characterName: string;
      serverSlug: string;
      region: string;
      extraParams?: Record<string, string | number | undefined>;
      baseUrl?: string;
    };

export const handler = async (event: WclClientEvent) => {
  const baseUrl = event.baseUrl ?? DEFAULT_BASE_URL;

  switch (event.action) {
    case 'getReportFights':
      return getReportFights(baseUrl, event.reportCode);
    case 'getSummaryTable':
      return getSummaryTable(baseUrl, event.reportCode, event.start, event.end);
    case 'getEvents':
      return getEvents(baseUrl, event.reportCode, event.start, event.end, event.filter, event.extraParams);
    case 'getTable':
      return getTable(baseUrl, event.view, event.reportCode, event.start, event.end, event.extraParams);
    case 'getFightCrits':
      return getFightCrits(baseUrl, event.reportCode, event.fightIds);
    case 'getFightRankings':
      return getFightRankings(baseUrl, event.reportCode, event.fightIds);
    case 'getParses':
      return getParses(baseUrl, event.characterName, event.serverSlug, event.region, event.extraParams);
    default: {
      const unreachable: never = event;
      throw new Error(`Unknown action: ${JSON.stringify(unreachable)}`);
    }
  }
};
