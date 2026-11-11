import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import logo from './assets/img/brand/logo.png';
import { CLASS_COLORS } from './classColors';
import { MOST_DEATHS_RESET } from './featureFlags';
import {
  computeMetrics,
  fetchHallRows,
  formatDate,
  readCachedRows,
  writeCachedRows,
  type CritRecord,
  type HallRow,
} from './hallOfRecords';

// "Negachinn & Spìkë", "Negachinn, Spìkë & Khalika", and beyond three
// "Negachinn, Spìkë, Khalika & 4 others" — a many-way tie right after a
// reset must not blow out a 240px column.
const MAX_SHOWN = 3;
function Holders({ names, classes }: { names: string[]; classes: Record<string, string> }) {
  const shown = names.slice(0, MAX_SHOWN);
  const extra = names.length - shown.length;
  return (
    <>
      {shown.map((name, i) => (
        <span key={name}>
          {i > 0 && <span className="holder-sep">{i === shown.length - 1 && extra === 0 ? ' & ' : ', '}</span>}
          <span style={classes[name] ? { color: CLASS_COLORS[classes[name]] } : undefined}>{name}</span>
        </span>
      ))}
      {extra > 0 && <span className="holder-sep"> &amp; {extra} others</span>}
    </>
  );
}

/** A single-hit record: the amount and holder, then what it was done with, on which boss, and when. */
function CritMetric({
  label,
  record,
  classes,
}: {
  label: string;
  record: CritRecord | null;
  classes: Record<string, string>;
}) {
  return (
    <div className="metric">
      <div className="metric-value">
        {record ? (
          <>
            <span className="metric-name">
              <span style={record.name && classes[record.name] ? { color: CLASS_COLORS[classes[record.name]] } : undefined}>
                {record.name ?? 'Unknown'}
              </span>
            </span>
            <span className="metric-num">{record.amount.toLocaleString()}</span>
          </>
        ) : (
          <span className="metric-num metric-empty">—</span>
        )}
      </div>
      <div className="metric-label">{label}</div>
      {record ? (
        <>
          <div className="metric-where">
            {record.ability ?? 'Unknown ability'}
            {record.boss ? ` on ${record.boss}` : ''}
          </div>
          {record.at && <div className="metric-when">{formatDate(record.at)}</div>}
        </>
      ) : (
        <div className="metric-note">no crits recorded yet</div>
      )}
    </div>
  );
}

export function Sidebar() {
  // Painted straight from the last visit's cache when there is one, so the Hall
  // is on screen immediately; the fresh copy replaces it a moment later.
  const [rows, setRows] = useState<HallRow[] | null>(() => readCachedRows());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchHallRows()
      .then((fresh) => {
        if (cancelled) return;
        writeCachedRows(fresh);
        // Skip the re-render when nothing changed (the common case).
        setRows((prev) => (prev && JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh));
        setFailed(false);
      })
      .catch(() => {
        // Metrics are garnish — if anything fails (cold start, auth), keep what
        // is already showing, or render the sidebar without the Hall.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Recomputed from the rows on every paint so the Phase 3 reset is judged
  // against the current clock, not whenever the cache was written.
  const metrics = useMemo(() => (rows ? computeMetrics(rows) : null), [rows]);

  return (
    <aside className="side">
      <div className="crest">
        <img src={logo} alt="The L Word" />
        <div className="crest-name">The L Word</div>
        <div className="crest-realm">Dreamscythe · US</div>
        <div className="crest-realm">Alliance</div>
      </div>

      <div className="nav-label">Analyze</div>
      <NavLink to="/" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
        <i className="ni ni-collection" />
        Raid Reports
      </NavLink>

      <div className="nav-label">Manage</div>
      <NavLink to="/admin" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
        <i className="ni ni-settings-gear-65" />
        Admin Ingest
      </NavLink>

      {!metrics && !failed && (
        <>
          <div className="nav-label">Hall of Records</div>
          {/* Reserves the Hall's height on the very first visit (no cache yet),
              so nothing below it jumps when the numbers arrive. */}
          <div className="side-metrics hall-skeleton" aria-busy="true" aria-label="Loading Hall of Records">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div className="metric" key={n}>
                <div className="skel-bar skel-num" />
                <div className="skel-bar skel-label" />
              </div>
            ))}
          </div>
        </>
      )}

      {metrics && (
        <>
          <div className="nav-label">Hall of Records</div>
          <div className="side-metrics">
            <div className="metric">
              <div className="metric-value">
                {metrics.leaders ? (
                  <>
                    <span className="metric-name">
                      <Holders names={metrics.leaders.names} classes={metrics.classByName} />
                    </span>
                    <span className="metric-num">{metrics.leaders.deaths}</span>
                  </>
                ) : (
                  // Kept visible rather than hidden: a vanishing metric
                  // reads as a bug, an empty one reads as a clean slate.
                  <span className="metric-num metric-empty">—</span>
                )}
              </div>
              <div className="metric-label">Most Deaths</div>
              {metrics.resetActive && (
                <div className="metric-note">
                  since {MOST_DEATHS_RESET.shortLabel} start on {MOST_DEATHS_RESET.labelDate}
                </div>
              )}
              {!metrics.leaders && <div className="metric-note">no deaths recorded yet</div>}
              {metrics.runnerUp && (
                <div className="metric-runner">
                  <span className="runner-name">
                    <Holders names={metrics.runnerUp.names} classes={metrics.classByName} />
                  </span>
                  <span className="runner-gap">
                    {metrics.runnerUpBehind} death{metrics.runnerUpBehind === 1 ? '' : 's'} behind
                  </span>
                </div>
              )}
              {metrics.priorRecord && (
                <div className="metric-prior">
                  {/* Label and holder on separate lines: at 240px the one-line
                      form wraps mid-value and orphans the count. */}
                  <span className="prior-label">Pre {MOST_DEATHS_RESET.label} Record</span>
                  <span className="prior-value">
                    <Holders names={metrics.priorRecord.names} classes={metrics.classByName} />
                    <span className="prior-count"> — {metrics.priorRecord.deaths}</span>
                  </span>
                </div>
              )}
            </div>
            <CritMetric label="Highest Damage Crit" record={metrics.topCritDamage} classes={metrics.classByName} />
            <CritMetric label="Highest Healing Crit" record={metrics.topCritHeal} classes={metrics.classByName} />
            <div className="metric">
              <div className="metric-value">
                <span className="metric-num">{metrics.bossKills}</span>
              </div>
              <div className="metric-label">Bosses Slain</div>
            </div>
            <div className="metric">
              <div className="metric-value">
                <span className="metric-num">{metrics.bossWipes}</span>
              </div>
              <div className="metric-label">Boss Wipes</div>
            </div>
            <div className="metric">
              <div className="metric-value">
                <span className="metric-num">{metrics.bossMinutes}</span>
              </div>
              <div className="metric-label">Minutes in Boss Combat</div>
            </div>
            {metrics.recordsSince && <div className="metric-since">Records kept since {metrics.recordsSince}</div>}
          </div>
        </>
      )}

      <div className="side-foot">Role Performance Breakdown</div>

      <div className="side-credit">
        <img
          className="credit-avatar"
          src="https://classic-armory.org/api/v1/character/avatar/tbc-anniversary/us/dreamscythe/oakenslug"
          alt="Oakenslug"
        />
        <div className="credit-line">
          Built with love for your pleasure by{' '}
          <a
            href="https://classic-armory.org/character/us/tbc-anniversary/dreamscythe/Oakenslug"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: CLASS_COLORS.Hunter }}
          >
            Oakenslug
          </a>
        </div>
        <div className="credit-quote">
          “If you ain't first, you're last.”
          <span className="credit-quote-by">— Ricky Bobby</span>
        </div>
      </div>
    </aside>
  );
}
