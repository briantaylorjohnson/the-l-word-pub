import { dataClient } from './amplifyDataClient';
import { getReadAuthMode } from './readAuthMode';
import { listAll } from './listAll';
import { MOST_DEATHS_RESET } from './featureFlags';

/**
 * Hall of Records data.
 *
 * Every number comes from the RaidNight rollup rows (one per raid, ~44 today):
 * each row carries that raid's own boss kills/wipes/seconds, every death with its
 * time, the roster's classes and its best crits, and this module just sums them.
 * It used to scan the Report, DeathRecord and GearListing tables on every page
 * load (~19k items, 72 requests, ~17 s). Now it is one small request.
 *
 * The rows are also cached in localStorage and painted immediately on the next
 * visit while a fresh copy loads in the background (stale-while-revalidate).
 * The cache holds the *rows*, not the computed metrics, so the Most Deaths reset
 * is still evaluated against the current clock every time.
 */

/** One crit record: who, how big, with what, on which boss, and when. */
export interface CritRecord {
  name: string | null;
  amount: number;
  ability: string | null;
  boss: string | null;
  fightId: string;
  at: string | null;
}

/** The slice of a RaidNight row the Hall needs. */
export interface HallRow {
  reportCode: string;
  killAttempts: number;
  wipeAttempts: number;
  bossSeconds: number;
  firstFightDate: string | null;
  deathEvents: Record<string, Array<number | null>>;
  classes: Record<string, string>;
  topCritDamage: CritRecord | null;
  topCritHeal: CritRecord | null;
}

/** Everyone sharing one death count — a tie is a shared record, not a race
 *  settled alphabetically. */
export interface DeathStanding {
  names: string[];
  deaths: number;
}

export interface GuildMetrics {
  leaders: DeathStanding | null;
  runnerUp: DeathStanding | null;
  runnerUpBehind: number;
  /** The standing as it was the moment the reset took effect. */
  priorRecord: DeathStanding | null;
  resetActive: boolean;
  classByName: Record<string, string>;
  bossKills: number;
  bossWipes: number;
  bossMinutes: number;
  recordsSince: string | null;
  /** All-time single-hit records (they do not reset at Phase 3). */
  topCritDamage: CritRecord | null;
  topCritHeal: CritRecord | null;
}

/** Groups a tally into distinct death counts, highest first, names sorted
 *  within each group so the order never depends on scan order. */
export function rankGroups(tally: Map<string, number>): DeathStanding[] {
  const byCount = new Map<number, string[]>();
  for (const [name, n] of tally) {
    if (n <= 0) continue;
    const bucket = byCount.get(n);
    if (bucket) bucket.push(name);
    else byCount.set(n, [name]);
  }
  return Array.from(byCount.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([deaths, names]) => ({ deaths, names: names.sort((a, b) => a.localeCompare(b)) }));
}

/** The larger record; a tie goes to whoever got there first. */
function betterCrit(a: CritRecord | null, b: CritRecord | null): CritRecord | null {
  if (!a) return b;
  if (!b) return a;
  if (b.amount > a.amount) return b;
  if (b.amount === a.amount && (b.at ?? '') < (a.at ?? '')) return b;
  return a;
}

export function computeMetrics(rows: HallRow[], now: number = Date.now()): GuildMetrics {
  const bossKills = rows.reduce((n, r) => n + r.killAttempts, 0);
  const bossWipes = rows.reduce((n, r) => n + r.wipeAttempts, 0);
  const bossMinutes = Math.round(rows.reduce((n, r) => n + r.bossSeconds, 0) / 60);

  const resetAt = MOST_DEATHS_RESET.enabled ? Date.parse(MOST_DEATHS_RESET.at) : null;
  const resetActive = resetAt !== null && now >= resetAt;

  const currentTally = new Map<string, number>();
  const priorTally = new Map<string, number>();
  const classByName: Record<string, string> = {};
  let topCritDamage: CritRecord | null = null;
  let topCritHeal: CritRecord | null = null;
  let firstFight: string | null = null;

  for (const row of rows) {
    for (const [name, cls] of Object.entries(row.classes)) if (!classByName[name]) classByName[name] = cls;
    topCritDamage = betterCrit(topCritDamage, row.topCritDamage);
    topCritHeal = betterCrit(topCritHeal, row.topCritHeal);
    if (row.firstFightDate && (firstFight === null || row.firstFightDate < firstFight)) firstFight = row.firstFightDate;

    for (const [name, times] of Object.entries(row.deathEvents)) {
      for (const t of times) {
        // A death with no placeable time (null) counts as current rather than
        // being dropped silently.
        const isPrior = resetActive && t !== null && t * 1000 < resetAt!;
        const tally = isPrior ? priorTally : currentTally;
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
    }
  }

  const currentGroups = rankGroups(currentTally);
  const leaders = currentGroups[0] ?? null;
  const runnerUp = currentGroups[1] ?? null;

  return {
    leaders,
    runnerUp,
    runnerUpBehind: leaders && runnerUp ? leaders.deaths - runnerUp.deaths : 0,
    priorRecord: resetActive ? (rankGroups(priorTally)[0] ?? null) : null,
    resetActive,
    classByName,
    bossKills,
    bossWipes,
    bossMinutes,
    recordsSince: firstFight ? formatDate(firstFight) : null,
    topCritDamage,
    topCritHeal,
  };
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// AppSync hands AWSJSON fields back as strings; tolerate an already-parsed value.
function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

const HALL_FIELDS = [
  'reportCode',
  'killAttempts',
  'wipeAttempts',
  'bossSeconds',
  'firstFightDate',
  'deathEvents',
  'classes',
  'topCritDamage',
  'topCritHeal',
] as const;

// Matches RAID_LIST_KEY in amplify/functions/_shared/raidNight.ts.
const RAID_LIST_KEY = 'RAID';

/** One request today; `listAll` follows the token if the raid count ever outgrows one page. */
export async function fetchHallRows(): Promise<HallRow[]> {
  const authMode = await getReadAuthMode();
  const raw = (await listAll((nextToken) =>
    dataClient.models.RaidNight.raidNightsByDate(
      { listKey: RAID_LIST_KEY },
      // A selectionSet keeps the payload to just what the Hall sums — no titles,
      // search text or the (large) per-fight crit map.
      { limit: 200, nextToken, authMode, selectionSet: [...HALL_FIELDS] }
    )
  )) as unknown as Array<Record<string, unknown>>;

  return raw
    .filter((r) => r && r.reportCode)
    .map((r) => ({
      reportCode: String(r.reportCode),
      killAttempts: Number(r.killAttempts ?? 0),
      wipeAttempts: Number(r.wipeAttempts ?? 0),
      bossSeconds: Number(r.bossSeconds ?? 0),
      firstFightDate: (r.firstFightDate as string | null) ?? null,
      deathEvents: parseJson<Record<string, Array<number | null>>>(r.deathEvents, {}),
      classes: parseJson<Record<string, string>>(r.classes, {}),
      topCritDamage: parseJson<CritRecord | null>(r.topCritDamage, null),
      topCritHeal: parseJson<CritRecord | null>(r.topCritHeal, null),
    }));
}

// --- stale-while-revalidate cache -------------------------------------------
// Bump the version when HallRow changes shape so an old cache is ignored.
const CACHE_KEY = 'lw:hall:v1';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function readCachedRows(): HallRow[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; rows: HallRow[] };
    if (!Array.isArray(parsed.rows) || Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS) return null;
    return parsed.rows;
  } catch {
    // Private windows, blocked storage or a corrupt entry: just load without it.
    return null;
  }
}

export function writeCachedRows(rows: HallRow[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), rows }));
  } catch {
    // Quota or blocked storage: the cache is an optimisation, never required.
  }
}
