import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { dataClient } from './amplifyDataClient';
import { useIsAdmin } from './useIsAdmin';
import { getReadAuthMode } from './readAuthMode';
import { listAll } from './listAll';
import { PageHeader } from './PageHeader';

type ReportListOptions = NonNullable<Parameters<typeof dataClient.models.Report.list>[0]>;

/** Raids requested per page, and added by each "Load more". */
const PAGE_SIZE = 15;

// The zone filter is now applied server-side, so the dropdown can no longer be
// derived from whatever happens to be loaded. This is the fixed TBC raid set;
// a zone with no raids simply returns an empty list.
const RAID_ZONES = [
  'Karazhan',
  "Gruul's Lair",
  "Magtheridon's Lair",
  'Serpentshrine Cavern',
  'Tempest Keep',
  'Hyjal Summit',
  'Black Temple',
  "Zul'Aman",
  'Sunwell Plateau',
];

// Matches RAID_LIST_KEY in amplify/functions/_shared/raidNight.ts — the
// constant partition the date index sorts within.
const RAID_LIST_KEY = 'RAID';

interface ReportRow {
  reportCode: string;
  fightId: string;
  title: string | null;
  zone: string | null;
  fightDate: string | null;
  durationSeconds: number | null;
  encounterName: string | null;
  isBossEncounter: boolean | null;
  kill: boolean | null;
  encounterGroupKey: string | null;
}

interface DisplayGroup {
  key: string;
  rows: ReportRow[];
}

/** One raid night as the list shows it collapsed — from the RaidNight summary alone. */
interface RaidSummary {
  reportCode: string;
  title: string;
  zone: string | null;
  fightDate: string | null;
  bossCount: number;
  killedCount: number;
}

interface RaidEncounters {
  loading: boolean;
  groups: DisplayGroup[];
}

// Attempts on the same boss (wipes + the eventual kill) share an
// encounterGroupKey — collapse those into one expandable row rather than
// listing every wipe as an unrelated encounter. One-off boss kills (no
// other attempts) fall to the `else` branch below and are never grouped.
function groupEncounterAttempts(rows: ReportRow[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const r of rows) {
    if (r.encounterGroupKey) {
      const groupKey = `${r.reportCode}#${r.encounterGroupKey}`;
      const existingIndex = indexByKey.get(groupKey);
      if (existingIndex !== undefined) {
        groups[existingIndex].rows.push(r);
        continue;
      }
      indexByKey.set(groupKey, groups.length);
      groups.push({ key: groupKey, rows: [r] });
    } else {
      groups.push({ key: `${r.reportCode}#${r.fightId}`, rows: [r] });
    }
  }
  for (const group of groups) {
    group.rows.sort((a, b) => (a.fightDate ?? '').localeCompare(b.fightDate ?? ''));
  }
  return groups;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Public, no login — the front door into the app. The admin-only delete
// affordance renders conditionally in the same list rather than a separate
// page.
//
// Raids are paged from the RaidNight summary table through its date index —
// newest first, PAGE_SIZE at a time — instead of reading every encounter row
// up front. A raid's encounters are fetched only when it is expanded. Zone and
// search are applied server-side so they span every page, not just the ones
// loaded so far.
export function ReportsList() {
  const isAdmin = useIsAdmin();
  const [raids, setRaids] = useState<RaidSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const [zoneFilter, setZoneFilter] = useState<string>('All zones');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [encounters, setEncounters] = useState<Record<string, RaidEncounters>>({});

  // Paging bookkeeping lives in refs: it is never rendered, and the async
  // fetch loop must see current values rather than a stale closure.
  const buffer = useRef<RaidSummary[]>([]);
  const nextToken = useRef<string | null>(null);
  const exhausted = useRef(false);
  // Bumped on every reset so a slow response for a superseded filter is dropped.
  const requestId = useRef(0);

  // Debounce the search box so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Returns the next PAGE_SIZE raids (or fewer at the end), or null if the
  // filters changed while it was in flight.
  const takePage = useCallback(async (id: number, zone: string, q: string): Promise<RaidSummary[] | null> => {
    const authMode = await getReadAuthMode();
    const zoneOn = zone !== 'All zones';
    // DynamoDB applies a filter *after* its page limit, so a filtered page can
    // come back short or empty with a token still pending. Fetch wider when
    // filtering and buffer the surplus; the buffer is what keeps each click at
    // exactly PAGE_SIZE.
    const fetchLimit = zoneOn || q ? PAGE_SIZE * 4 : PAGE_SIZE;
    while (buffer.current.length < PAGE_SIZE && !exhausted.current) {
      const res = await dataClient.models.RaidNight.raidNightsByDate(
        { listKey: RAID_LIST_KEY },
        {
          sortDirection: 'DESC',
          limit: fetchLimit,
          nextToken: nextToken.current ?? undefined,
          filter: {
            ...(zoneOn ? { zone: { eq: zone } } : {}),
            ...(q ? { searchText: { contains: q } } : {}),
          },
          authMode,
        }
      );
      if (id !== requestId.current) return null;
      buffer.current.push(
        ...res.data.filter(Boolean).map((r) => ({
          reportCode: r.reportCode,
          title: r.title ?? r.reportCode,
          zone: r.zone ?? null,
          fightDate: r.fightDate ?? null,
          bossCount: r.bossCount ?? 0,
          killedCount: r.killedCount ?? 0,
        }))
      );
      nextToken.current = res.nextToken ?? null;
      if (!nextToken.current) exhausted.current = true;
    }
    return buffer.current.splice(0, PAGE_SIZE);
  }, []);

  // (Re)start from the top whenever a filter changes — including on mount.
  useEffect(() => {
    const id = ++requestId.current;
    buffer.current = [];
    nextToken.current = null;
    exhausted.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setRaids([]);
    (async () => {
      try {
        const page = await takePage(id, zoneFilter, query);
        if (page === null) return;
        setRaids(page);
        setHasMore(buffer.current.length > 0 || !exhausted.current);
      } catch (err) {
        if (id === requestId.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    })();
  }, [zoneFilter, query, takePage]);

  async function loadMore() {
    const id = requestId.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await takePage(id, zoneFilter, query);
      if (page === null) return;
      setRaids((prev) => [...prev, ...page]);
      // DynamoDB can hand back a token when exactly a page remained; the next
      // fetch then comes back empty and the button goes away.
      setHasMore(buffer.current.length > 0 || !exhausted.current);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestId.current) setLoadingMore(false);
    }
  }

  // Trash-gap encounters are permanently excluded from this list — gear
  // doesn't change between a trash pull and the boss attempt right after
  // it, so a separate trash-scoped view is noise, not new information.
  // Encounters with a zero or missing duration are excluded too — real
  // boss fights always take some non-zero time, so a 0/null durationSeconds
  // means either a WCL data glitch or a Report row ingested before this
  // field existed, not a genuine encounter worth showing. In both cases,
  // the underlying Report/GearIssue/etc. rows are untouched and still
  // reachable by direct URL; this is a display-only exclusion. (The RaidNight
  // counts apply the same rule.)
  async function loadEncounters(reportCode: string) {
    setEncounters((prev) => ({ ...prev, [reportCode]: { loading: true, groups: [] } }));
    try {
      const authMode = await getReadAuthMode();
      // `reportCode` is Report's partition key, so this is a keyed Query for
      // just this raid's rows, not a table scan. The installed types do not
      // expose key arguments on list() for this model, though the generated
      // GraphQL query takes them — hence the cast.
      const rows = (await listAll((nextToken) =>
        dataClient.models.Report.list({ reportCode, limit: 200, nextToken, authMode } as unknown as ReportListOptions)
      )) as unknown as ReportRow[];
      const displayable: ReportRow[] = rows
        .filter((r) => r.isBossEncounter && !!r.durationSeconds)
        .map((r) => ({
          reportCode: r.reportCode,
          fightId: r.fightId,
          title: r.title ?? null,
          zone: r.zone ?? null,
          fightDate: r.fightDate ?? null,
          durationSeconds: r.durationSeconds ?? null,
          encounterName: r.encounterName ?? null,
          isBossEncounter: r.isBossEncounter ?? null,
          kill: r.kill ?? null,
          encounterGroupKey: r.encounterGroupKey ?? null,
        }));
      // Newest boss first, matching the order the list has always shown.
      displayable.sort((a, b) => (b.fightDate ?? '').localeCompare(a.fightDate ?? ''));
      setEncounters((prev) => ({
        ...prev,
        [reportCode]: { loading: false, groups: groupEncounterAttempts(displayable) },
      }));
    } catch (err) {
      setEncounters((prev) => {
        const { [reportCode]: _failed, ...rest } = prev;
        return rest;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleRaid(reportCode: string) {
    const key = `raid:${reportCode}`;
    const opening = !expandedGroups.has(key);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening && !encounters[reportCode]) void loadEncounters(reportCode);
  }

  async function handleDelete(reportCode: string, fightId: string, label: string) {
    if (!confirm(`Delete encounter "${label}" (${reportCode} fight ${fightId})? This can't be undone.`)) {
      return;
    }
    const key = `${reportCode}#${fightId}`;
    setDeletingKey(key);
    setError(null);
    try {
      const res = await dataClient.mutations.deleteReportCascade(
        { reportCode, fightId },
        { authMode: 'userPool' }
      );
      if (res.errors && res.errors.length > 0) {
        throw new Error(res.errors.map((e) => e.message).join('; '));
      }
      // The delete Lambda recomputes the server-side summary; mirror it locally
      // so the open list is right without a refetch.
      const remaining = (encounters[reportCode]?.groups ?? [])
        .map((g) => ({ ...g, rows: g.rows.filter((r) => r.fightId !== fightId) }))
        .filter((g) => g.rows.length > 0);
      setEncounters((prev) => ({ ...prev, [reportCode]: { loading: false, groups: remaining } }));
      setRaids((prev) =>
        remaining.length === 0
          ? prev.filter((r) => r.reportCode !== reportCode)
          : prev.map((r) =>
              r.reportCode === reportCode
                ? { ...r, bossCount: remaining.length, killedCount: remaining.filter((g) => g.rows.some((x) => x.kill)).length }
                : r
            )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingKey(null);
    }
  }

  // One row per encounter (boss), regardless of how many attempts it took —
  // every attempt renders as a numbered gem pill in the Attempts column
  // (green kill / red wipe), each linking to that attempt's full breakdown.
  function renderEncounterRow(group: DisplayGroup) {
    const latest = group.rows[group.rows.length - 1];
    return (
      <div className="enc" key={group.key}>
        <span className="boss">{latest.encounterName}</span>
        <span className="attempts">
          <span className="attempts-lbl">Attempts</span>
          {group.rows.map((r, i) => {
            const attemptKey = `${r.reportCode}#${r.fightId}`;
            const label = r.encounterName ?? r.fightId;
            return (
              <span key={attemptKey} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Link
                  to={`/reports/${r.reportCode}/${r.fightId}`}
                  className={`pill ${r.kill ? 'kill' : 'wipe'}`}
                  title={`Attempt ${i + 1} — ${r.kill ? 'Kill' : 'Wipe'}`}
                >
                  {i + 1}
                </Link>
                {isAdmin && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleDelete(r.reportCode, r.fightId, label)}
                    disabled={deletingKey === attemptKey}
                    aria-label={`Delete attempt ${i + 1} of ${label}`}
                    title="Delete this attempt"
                  >
                    <i className={deletingKey === attemptKey ? 'ni ni-time-alarm' : 'ni ni-fat-remove'} />
                  </button>
                )}
              </span>
            );
          })}
        </span>
        <span className="enc-date">{fmtTime(latest.fightDate)}</span>
        <span className="enc-dur">{fmtDuration(latest.durationSeconds)}</span>
      </div>
    );
  }

  function renderRaid(raid: RaidSummary) {
    const key = `raid:${raid.reportCode}`;
    const isExpanded = expandedGroups.has(key);
    const loaded = encounters[raid.reportCode];
    return (
      <Fragment key={key}>
        <div className={`raid${isExpanded ? ' open' : ''}`}>
          <div className="raid-head" onClick={() => toggleRaid(raid.reportCode)}>
            <span className="chev">▶</span>
            <span className="raid-title">{raid.title}</span>
            <span className="prog">
              <span className="prog-bar">
                <i style={{ width: `${raid.bossCount ? (raid.killedCount / raid.bossCount) * 100 : 0}%` }} />
              </span>
              {raid.killedCount}/{raid.bossCount}
            </span>
            <span className="raid-meta">
              <span className="zone-chip">◆ {raid.zone}</span>
              <span>{fmtDate(raid.fightDate)}</span>
            </span>
          </div>
          {isExpanded && (
            <div className="raid-body">
              {!loaded || loaded.loading ? (
                <p className="loading-note">Loading encounters…</p>
              ) : (
                loaded.groups.map((group) => renderEncounterRow(group))
              )}
            </div>
          )}
        </div>
      </Fragment>
    );
  }

  const filters = (
    <div className="filters">
      <select className="f-select" value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}>
        <option>All zones</option>
        {RAID_ZONES.map((z) => (
          <option key={z}>{z}</option>
        ))}
      </select>
      <input
        className="f-search"
        placeholder="Search bosses…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
    </div>
  );

  const filtersActive = zoneFilter !== 'All zones' || query !== '';

  return (
    <>
      <PageHeader
        title={
          <>
            Raid <span className="accent">Reports</span>
          </>
        }
        subtitle="Every raid night, pulled straight from Warcraft Logs"
        actions={filters}
      />

      {error && <div className="alert error">{error}</div>}

      {loading && raids.length === 0 ? (
        <p className="loading-note">Consulting the archives…</p>
      ) : raids.length === 0 ? (
        <div className="panel">
          <div className="panel-body dim">
            {filtersActive ? 'No raids match these filters.' : 'No reports ingested yet.'}
          </div>
        </div>
      ) : (
        <>
          {raids.map((raid) => renderRaid(raid))}
          <div className="list-foot">
            Showing {raids.length} {raids.length === 1 ? 'raid' : 'raids'}
            {hasMore && (
              <button type="button" className="btn btn-ghost load-more" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
