import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { dataClient } from './amplifyDataClient';
import { getReadAuthMode } from './readAuthMode';
import { listAll } from './listAll';
import { PageHeader } from './PageHeader';
import { ArmoryLink, WowheadItemLink } from './links';
import { slotName } from './slotNames';
import { CLASS_COLORS } from './classColors';
import { ordinal, parseColor } from './parseColors';

interface WclGearItem {
  id: number;
  slot: number;
  name: string;
  permanentEnchant?: number;
  permanentEnchantName?: string;
  gems?: Array<{ id: number }>;
}

// Shirt and tabard are cosmetic — noise in a gear breakdown.
const GEAR_HIDDEN_SLOTS = new Set([3, 18]);

// Gear Listing lays slots out like the in-game character pane: armor down
// the left, accessories down the right, weapons in their own section
// below a divider.
const GEAR_LAYOUT_TOP: [number[], number[]] = [
  [0, 1, 2, 14, 4, 8], // Head, Neck, Shoulder, Back, Chest, Wrist
  [9, 5, 6, 7, 10, 11, 12, 13], // Gloves, Waist, Legs, Boots, Rings, Trinkets
];
const GEAR_LAYOUT_BOTTOM: [number[], number[]] = [
  [15, 16], // Main Hand, Off Hand
  [17], // Ranged
];

// WoW's item-quality colors, as seen on every tooltip since 2004.
const QUALITY_COLORS: Record<string, string> = {
  Common: '#ffffff',
  Uncommon: '#1eff00',
  Rare: '#0070dd',
  Epic: '#a335ee',
};

// Socket colors for the gem pips — what a WoW player expects a gem to
// look like (a Living Ruby is red no matter its quality tier). Falls back
// to the quality tint for the handful of gems without color data.
const GEM_SOCKET_COLORS: Record<string, string> = {
  Red: '#ff4b4b',
  Yellow: '#ffd100',
  Blue: '#4d9fff',
  Orange: '#ff9a3c',
  Green: '#3fd67d',
  Purple: '#b355e0',
  Meta: '#e8e8f0',
  Prismatic: '#8be9fd',
};

interface GemInfo {
  quality: string;
  name: string | null;
  color: string | null;
}

// Mother Shahraz (Black Temple) needs 244 shadow resistance from everyone
// except the tanks, but 70 of that comes from a priest's Prayer of Shadow
// Protection on the night, leaving 174 to bring from gear. This is a *gear*
// check — what a raider controls before they turn up — so it tests
// srFromGear and ignores buffs.
//
// The 10 below that is deliberate slack for racial resistance, which we
// can't yet read: a Draenei arrives with +10 Shadow before any gear, so a
// Draenei on 164 gear is genuinely at 174 and shouldn't be flagged. WCL
// exposes no race anywhere in its v1 API (see shadowResistance.ts), so
// rather than fail those raiders we extend the benefit of the doubt to
// everyone. The trade is accepted knowingly: a non-Draenei sitting between
// 164 and 173 passes when they are in fact short. Once the CharacterRace
// table is populated this should go back to a hard 174 plus the real
// racial.
const BT_SHADOW_RES_THRESHOLD = 164;

type GearIssueType = 'emptySlot' | 'noEnchant' | 'noGem' | 'weakEnchant' | 'weakGem';

interface GearIssueEntry {
  slot: number;
  itemId: number;
  itemName?: string;
  issueType: GearIssueType;
  currentValue?: string;
}

const ISSUE_LABELS: Record<GearIssueType, string> = {
  emptySlot: 'Empty Slot',
  noEnchant: 'No Enchant',
  noGem: 'No Gem',
  weakEnchant: 'Weak Enchant',
  weakGem: 'Weak Gem',
};

// Only noGem/weakGem can legitimately repeat more than once for the same
// item (one entry per empty or per weak-quality socket) — enchant issues
// are already at most one per item. Falls back to the singular label for
// any type without a plural form.
const ISSUE_LABELS_PLURAL: Partial<Record<GearIssueType, string>> = {
  noGem: 'No Gems',
  weakGem: 'Weak Gems',
};

// warn (amber) = something is there but it's underpowered;
// danger (red) = something is missing outright.
const ISSUE_TAG_CLASS: Record<GearIssueType, string> = {
  emptySlot: 'danger',
  noEnchant: 'danger',
  noGem: 'danger',
  weakEnchant: 'warn',
  weakGem: 'warn',
};

const ROLE_ORDER: Record<string, number> = { tank: 0, healer: 1, dps: 2 };

interface CharMeta {
  cls: string | null;
  spec: string | null;
  role: string | null;
}

function CharacterCell({ name, meta }: { name: string; meta?: CharMeta }) {
  const color = meta?.cls ? CLASS_COLORS[meta.cls] : undefined;
  return (
    <div className="char-cell">
      <ArmoryLink characterName={name} color={color} />
      {meta?.cls && (
        <div className="char-class">
          {meta.cls}
          {meta.spec ? ` · ${meta.spec}` : ''}
        </div>
      )}
      {meta?.role && (
        <div className="char-role">
          <span className={`role-chip ${meta.role}`}>{meta.role}</span>
        </div>
      )}
    </div>
  );
}

interface SlotIssueBadge {
  issueType: GearIssueType;
  label: string;
  currentValue?: string;
}

interface SlotIssueGroup {
  slot: number;
  itemId: number;
  itemName?: string;
  badges: SlotIssueBadge[];
}

// Collapses a character's flat GearIssueEntry[] into one group per gear
// slot, merging same-type duplicates (e.g. two weak gems in one item) into
// a single pluralized badge instead of repeating the item name and note
// once per raw entry.
function groupIssuesBySlot(issues: GearIssueEntry[]): SlotIssueGroup[] {
  const bySlot = new Map<number, GearIssueEntry[]>();
  for (const issue of issues) {
    const existing = bySlot.get(issue.slot);
    if (existing) existing.push(issue);
    else bySlot.set(issue.slot, [issue]);
  }

  const groups: SlotIssueGroup[] = [];
  for (const [slot, slotIssues] of bySlot) {
    const byType = new Map<GearIssueType, GearIssueEntry[]>();
    for (const issue of slotIssues) {
      const existing = byType.get(issue.issueType);
      if (existing) existing.push(issue);
      else byType.set(issue.issueType, [issue]);
    }

    const badges: SlotIssueBadge[] = Array.from(byType.entries()).map(([issueType, entries]) => {
      const label =
        entries.length > 1 ? (ISSUE_LABELS_PLURAL[issueType] ?? ISSUE_LABELS[issueType]) : ISSUE_LABELS[issueType];
      const currentValues = Array.from(
        new Set(entries.map((e) => e.currentValue).filter((v): v is string => !!v))
      );
      return { issueType, label, currentValue: currentValues.length > 0 ? currentValues.join(', ') : undefined };
    });

    groups.push({ slot, itemId: slotIssues[0].itemId, itemName: slotIssues[0].itemName, badges });
  }

  return groups.sort((a, b) => a.slot - b.slot);
}

interface ValidationDetail {
  bossName: string;
  npcIds: string;
  minKills: number;
  actualKills: number;
  passed: boolean;
}

interface ConsumableRow {
  characterName: string;
  score: number;
  battleElixir: number;
  guardianElixir: number;
  flask: number;
  food: number;
  scroll: number;
  weaponEnhancement: number;
  potionUse: number;
  healthstoneUse: number;
}

interface DrumRow {
  characterName: string;
  totalDrums: number;
  buffsPerDrum: number;
  pointlessCasts: number;
}

interface DamageRow {
  characterName: string;
  totalDamage: number;
  dps: number;
  pctOfRaid: number;
  /** WCL percentile; null for wipes, unranked kills and hidden rankings. */
  parsePercent: number | null;
}

interface ShadowResistanceRow {
  characterName: string;
  srFromGear: number;
  srFromBuffsAndRace: number;
  srTotal: number;
}

interface DeathEntry {
  timeMs: number;
  abilityName: string | null;
}

interface ReportDetailState {
  reportTitle: string | null;
  zone: string | null;
  encounterName: string | null;
  isBossEncounter: boolean | null;
  kill: boolean | null;
  gearListings: Array<{
    characterName: string;
    gear: WclGearItem[];
    characterClass: string | null;
    spec: string | null;
    role: string | null;
  }>;
  gearIssues: Array<{ characterName: string; issues: GearIssueEntry[] }>;
  deaths: Array<{ characterName: string; deaths: DeathEntry[] }>;
  validation: {
    zone: string;
    isValid: boolean;
    bossesRequired: number;
    bossesKilled: number;
    details: ValidationDetail[];
  } | null;
  consumables: ConsumableRow[];
  drums: DrumRow[];
  damage: DamageRow[];
  shadowResistance: ShadowResistanceRow[];
}

type Tab =
  | 'gearSummary'
  | 'validation'
  | 'consumables'
  | 'drums'
  | 'damage'
  | 'shadowResistance'
  | 'gearIssues'
  | 'gearListing'
  | 'deaths';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'damage', label: 'Damage' },
  { id: 'gearSummary', label: 'Gear Check Summary' },
  { id: 'gearIssues', label: 'Gear Issues' },
  { id: 'deaths', label: 'Deaths' },
  { id: 'consumables', label: 'Consumables' },
  { id: 'drums', label: 'Drums' },
  { id: 'shadowResistance', label: 'Shadow Resistance' },
  { id: 'gearListing', label: 'Gear Listing' },
];

// Shadow resistance only matters for Mother Shahraz, so the tab is offered on
// that encounter alone. Log Validation is intentionally not in the strip: its
// data is still ingested, the tab is just not shown.
const SHADOW_RESISTANCE_ENCOUNTER = 'Mother Shahraz';

const ISSUE_FILTERS = ['All', 'Issues', 'No Issues', 'Enchant Issues', 'Empty Slot'] as const;
type IssueFilter = (typeof ISSUE_FILTERS)[number];

const SORT_KEYS = ['Character Name', 'Class', 'Role'] as const;
// 'Time' (time of first death) is only offered on the Deaths tab, and the
// damage keys only on the Damage tab.
const DAMAGE_SORT_KEYS = ['Total Damage', 'DPS', 'Parse'] as const;
type DamageSortKey = (typeof DAMAGE_SORT_KEYS)[number];
type SortKey = (typeof SORT_KEYS)[number] | 'Time' | DamageSortKey;
const isDamageSort = (k: SortKey): k is DamageSortKey => (DAMAGE_SORT_KEYS as readonly string[]).includes(k);

// The check rune (and its red mirror) used across all yes/no table cells.
function ReadyCheck({ title }: { title?: string }) {
  return (
    <span className="ready-check" title={title}>
      <i className="ni ni-check-bold" />
    </span>
  );
}

function fmtFightTime(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ReportDetail() {
  const { reportCode, fightId } = useParams<{ reportCode: string; fightId: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('damage');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportDetailState | null>(null);
  const [gemInfo, setGemInfo] = useState<Map<number, GemInfo>>(new Map());
  const [enchantNames, setEnchantNames] = useState<Map<number, string>>(new Map());

  const [classFilter, setClassFilter] = useState('All classes');
  const [specFilter, setSpecFilter] = useState('All specs');
  const [roleFilter, setRoleFilter] = useState('All roles');
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('All');
  const [sortKey, setSortKey] = useState<SortKey>('Total Damage');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    if (!reportCode || !fightId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const authMode = await getReadAuthMode();
        const filter = { reportCode: { eq: reportCode }, fightId: { eq: fightId } };
        const [reportRes, listings, issues, deathRows, gemQualityRows, enchantNameRows, validationRes, consumables, drums, damage, sr] = await Promise.all([
          dataClient.models.Report.get({ reportCode: reportCode!, fightId: fightId! }, { authMode }),
          listAll((nextToken) => dataClient.models.GearListing.list({ filter, authMode, nextToken })),
          listAll((nextToken) => dataClient.models.GearIssue.list({ filter, authMode, nextToken })),
          listAll((nextToken) => dataClient.models.DeathRecord.list({ filter, authMode, nextToken })),
          // Small static reference table (~240 rows) — lets the Gear
          // Listing tab color each socketed gem by its WoW quality tier.
          listAll((nextToken) => dataClient.models.GemQuality.list({ authMode, nextToken })),
          // Enchant effect id -> real TBC name (WCL's own names are
          // retail-mapped and wrong for TBC).
          listAll((nextToken) => dataClient.models.EnchantName.list({ authMode, nextToken })),
          // Log validity is raid-wide, not per-encounter — one shared row
          // per reportCode, looked up the same way regardless of which
          // encounter is currently open.
          dataClient.models.ValidationResult.get({ reportCode: reportCode! }, { authMode }),
          listAll((nextToken) => dataClient.models.ConsumableScore.list({ filter, authMode, nextToken })),
          listAll((nextToken) => dataClient.models.DrumStat.list({ filter, authMode, nextToken })),
          listAll((nextToken) => dataClient.models.DamageStat.list({ filter, authMode, nextToken })),
          listAll((nextToken) => dataClient.models.ShadowResistanceResult.list({ filter, authMode, nextToken })),
        ]);

        if (cancelled) return;

        if (!reportRes.data) {
          setError("No report found for that reportCode/fightId — it may have been deleted.");
          return;
        }

        // Rows can come back null if they fail AppSync's per-item schema
        // validation (e.g. seeded without timestamps) — skip rather than crash.
        setGemInfo(
          new Map(
            gemQualityRows
              .filter((g) => g != null)
              .map((g) => [g.itemId, { quality: g.quality ?? '', name: g.name ?? null, color: g.color ?? null }])
          )
        );
        setEnchantNames(
          new Map(enchantNameRows.filter((e) => e != null).map((e) => [e.enchantId, e.name]))
        );

        setResult({
          reportTitle: `${reportRes.data.title} — ${reportRes.data.zone}`,
          zone: reportRes.data.zone ?? null,
          encounterName: reportRes.data.encounterName ?? null,
          isBossEncounter: reportRes.data.isBossEncounter ?? null,
          kill: reportRes.data.kill ?? null,
          gearListings: listings.map((row) => ({
            characterName: row.characterName,
            gear: JSON.parse(row.gear as unknown as string) as WclGearItem[],
            characterClass: row.characterClass ?? null,
            spec: row.spec ?? null,
            role: row.role ?? null,
          })),
          gearIssues: issues.map((row) => ({
            characterName: row.characterName,
            issues: JSON.parse(row.issues as unknown as string) as GearIssueEntry[],
          })),
          deaths: deathRows.map((row) => ({
            characterName: row.characterName,
            deaths: JSON.parse(row.deaths as unknown as string) as DeathEntry[],
          })),
          validation: validationRes.data
            ? {
                zone: validationRes.data.zone ?? '',
                isValid: validationRes.data.isValid ?? false,
                bossesRequired: validationRes.data.bossesRequired ?? 0,
                bossesKilled: validationRes.data.bossesKilled ?? 0,
                details: JSON.parse(validationRes.data.details as unknown as string) as ValidationDetail[],
              }
            : null,
          consumables: consumables.map((row) => ({
            characterName: row.characterName,
            score: row.score ?? 0,
            battleElixir: row.battleElixir ?? 0,
            guardianElixir: row.guardianElixir ?? 0,
            flask: row.flask ?? 0,
            food: row.food ?? 0,
            scroll: row.scroll ?? 0,
            weaponEnhancement: row.weaponEnhancement ?? 0,
            potionUse: row.potionUse ?? 0,
            healthstoneUse: row.healthstoneUse ?? 0,
          })),
          drums: drums.map((row) => ({
            characterName: row.characterName,
            totalDrums: row.totalDrums ?? 0,
            buffsPerDrum: row.buffsPerDrum ?? 0,
            pointlessCasts: row.pointlessCasts ?? 0,
          })),
          damage: damage.filter(Boolean).map((row) => ({
            characterName: row.characterName,
            totalDamage: row.totalDamage ?? 0,
            dps: row.dps ?? 0,
            pctOfRaid: row.pctOfRaid ?? 0,
            parsePercent: row.parsePercent ?? null,
          })),
          shadowResistance: sr.map((row) => ({
            characterName: row.characterName,
            srFromGear: row.srFromGear ?? 0,
            srFromBuffsAndRace: row.srFromBuffsAndRace ?? 0,
            srTotal: row.srTotal ?? 0,
          })),
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [reportCode, fightId]);

  // name -> class/spec/role, joined onto every tab from GearListing (the
  // only table that stores it). Older rows ingested before those fields
  // existed just come back null — the UI degrades to plain gold names.
  const roster = useMemo(() => {
    const map = new Map<string, CharMeta>();
    for (const row of result?.gearListings ?? []) {
      map.set(row.characterName, { cls: row.characterClass, spec: row.spec, role: row.role });
    }
    return map;
  }, [result]);

  const damageByName = useMemo(() => new Map((result?.damage ?? []).map((d) => [d.characterName, d])), [result]);

  const issuesByName = useMemo(() => {
    const map = new Map<string, GearIssueEntry[]>();
    for (const row of result?.gearIssues ?? []) map.set(row.characterName, row.issues);
    return map;
  }, [result]);

  const deathsByName = useMemo(() => {
    const map = new Map<string, DeathEntry[]>();
    for (const row of result?.deaths ?? []) map.set(row.characterName, row.deaths);
    return map;
  }, [result]);

  // Gear-only, matching BT_SHADOW_RES_THRESHOLD — buffs and racials are
  // deliberately excluded from the gear check.
  const srGearByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of result?.shadowResistance ?? []) map.set(row.characterName, row.srFromGear);
    return map;
  }, [result]);

  // characterName -> slot -> equipped item, for cross-referencing gear
  // issues against the actual gear (e.g. naming the weak gems).
  const gearByCharacter = useMemo(() => {
    const map = new Map<string, Map<number, WclGearItem>>();
    for (const row of result?.gearListings ?? []) {
      map.set(row.characterName, new Map(row.gear.map((g) => [g.slot, g])));
    }
    return map;
  }, [result]);

  // For a weakGem issue, upgrade the stored note (just a tier like
  // "Uncommon") to the actual gem names, resolved from the character's
  // equipped item + the gem lookup table. Falls back to the stored tier
  // when anything is missing (old data, unknown gems).
  function weakGemNote(characterName: string, slot: number, fallback?: string): string | undefined {
    const item = gearByCharacter.get(characterName)?.get(slot);
    if (!item) return fallback;
    const weak = (item.gems ?? [])
      .map((g) => gemInfo.get(g.id))
      .filter((info): info is GemInfo => !!info && (info.quality === 'Common' || info.quality === 'Uncommon'));
    if (weak.length === 0) return fallback;
    const counts = new Map<string, number>();
    for (const w of weak) {
      const label = `${w.name ?? 'Unknown gem'} (${w.quality})`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
      .join(', ');
  }

  const classes = useMemo(
    () =>
      Array.from(
        new Set(Array.from(roster.values()).map((m) => m.cls).filter((c): c is string => !!c))
      ).sort(),
    [roster]
  );

  const specs = useMemo(() => {
    const relevant = Array.from(roster.values()).filter(
      (m) => classFilter === 'All classes' || m.cls === classFilter
    );
    return Array.from(new Set(relevant.map((m) => m.spec).filter((s): s is string => !!s))).sort();
  }, [roster, classFilter]);

  const roles = useMemo(() => {
    const present = new Set(Array.from(roster.values()).map((m) => m.role).filter((r): r is string => !!r));
    // Fixed tank/healer/dps order rather than alphabetical.
    return Object.keys(ROLE_ORDER).filter((r) => present.has(r));
  }, [roster]);

  // The issue filter only exists on the two gear tabs; class/spec filters
  // and sorting apply to every character-listing tab.
  function matchesIssueFilter(name: string): boolean {
    if (issueFilter === 'All') return true;
    const issues = issuesByName.get(name) ?? [];
    switch (issueFilter) {
      case 'Issues':
        return issues.length > 0;
      case 'No Issues':
        return issues.length === 0;
      case 'Enchant Issues':
        return issues.some((i) => i.issueType === 'noEnchant' || i.issueType === 'weakEnchant');
      case 'Empty Slot':
        return issues.some((i) => i.issueType === 'emptySlot');
    }
  }

  // A tab-specific key left selected after switching tabs falls back to
  // name order rather than erroring.
  const effectiveSortKey: SortKey =
    (sortKey === 'Time' && activeTab !== 'deaths') || (isDamageSort(sortKey) && activeTab !== 'damage')
      ? 'Character Name'
      : sortKey;

  const showShadowResist = result?.encounterName === SHADOW_RESISTANCE_ENCOUNTER;
  const visibleTabs = TABS.filter((t) => t.id !== 'shadowResistance' || showShadowResist);

  function selectTab(next: Tab) {
    setActiveTab(next);
    if (next === 'damage') {
      // Biggest number first is the only sensible default for damage.
      setSortKey('Total Damage');
      setSortDir('desc');
    } else if (isDamageSort(sortKey)) {
      setSortKey('Character Name');
      setSortDir('asc');
    }
  }

  function prepRows<T extends { characterName: string }>(rows: T[], opts?: { applyIssueFilter?: boolean }): T[] {
    const filtered = rows.filter((r) => {
      const meta = roster.get(r.characterName);
      if (classFilter !== 'All classes' && meta?.cls !== classFilter) return false;
      if (specFilter !== 'All specs' && meta?.spec !== specFilter) return false;
      if (roleFilter !== 'All roles' && meta?.role !== roleFilter) return false;
      if (opts?.applyIssueFilter && !matchesIssueFilter(r.characterName)) return false;
      return true;
    });
    // 'Time' only makes sense on the Deaths tab — if it's still selected
    // after switching tabs, fall back to name order rather than erroring.
    const effectiveSort = effectiveSortKey;
    const dir = sortDir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => {
      const ma = roster.get(a.characterName);
      const mb = roster.get(b.characterName);
      if (effectiveSort === 'Time') {
        // Sort by first death; survivors always sink to the bottom
        // regardless of direction — "no death" isn't a large or small
        // time, it's the absence of one.
        const ta = deathsByName.get(a.characterName)?.[0]?.timeMs;
        const tb = deathsByName.get(b.characterName)?.[0]?.timeMs;
        if (ta === undefined && tb === undefined) return a.characterName.localeCompare(b.characterName);
        if (ta === undefined) return 1;
        if (tb === undefined) return -1;
        if (ta !== tb) return (ta - tb) * dir;
        return a.characterName.localeCompare(b.characterName);
      }
      if (isDamageSort(effectiveSort)) {
        // Rows with no value (e.g. an unranked parse) sink to the bottom in
        // either direction — "no parse" is not a low parse.
        const pick = (name: string) => {
          const d = damageByName.get(name);
          if (!d) return undefined;
          if (effectiveSort === 'Total Damage') return d.totalDamage;
          if (effectiveSort === 'DPS') return d.dps;
          // Healers' parse is withheld in the cell, so it must not order them either.
          if (roster.get(name)?.role === 'healer') return undefined;
          return d.parsePercent ?? undefined;
        };
        const va = pick(a.characterName);
        const vb = pick(b.characterName);
        if (va === undefined && vb === undefined) return a.characterName.localeCompare(b.characterName);
        if (va === undefined) return 1;
        if (vb === undefined) return -1;
        if (va !== vb) return (va - vb) * dir;
        return a.characterName.localeCompare(b.characterName);
      }
      if (effectiveSort === 'Class') {
        const cmp = (ma?.cls ?? '￿').localeCompare(mb?.cls ?? '￿');
        if (cmp !== 0) return cmp * dir;
      } else if (effectiveSort === 'Role') {
        const cmp = (ROLE_ORDER[ma?.role ?? ''] ?? 99) - (ROLE_ORDER[mb?.role ?? ''] ?? 99);
        if (cmp !== 0) return cmp * dir;
      }
      return a.characterName.localeCompare(b.characterName) * dir;
    });
  }

  const backLink = (
    <Link to="/" className="btn btn-ghost btn-sm">
      <i className="ni ni-bold-left" /> All reports
    </Link>
  );

  const encounterSubtitle = result && (
    <>
      {result.encounterName}
      {result.isBossEncounter ? (
        <span className={`tag-pill ${result.kill ? 'kill' : 'wipe'}`}>{result.kill ? 'KILL' : 'WIPE'}</span>
      ) : (
        <span className="tag-pill neutral">TRASH</span>
      )}
    </>
  );

  const isGearTab = activeTab === 'gearSummary' || activeTab === 'gearIssues';

  return (
    <>
      <PageHeader title={result?.reportTitle ?? 'Report'} subtitle={encounterSubtitle} actions={backLink} />

      {loading && <p className="loading-note">Consulting the archives…</p>}
      {error && <div className="alert error">{error}</div>}

      {result && (
        <>
          <div className="tabs">
            {visibleTabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={'tab' + (activeTab === tab.id ? ' active' : '')}
                onClick={() => selectTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab !== 'validation' && (
            <div className="filter-bar">
              <span className="filter-lbl">Filter</span>
              <select
                className="f-select"
                value={classFilter}
                onChange={(e) => {
                  setClassFilter(e.target.value);
                  setSpecFilter('All specs');
                }}
              >
                <option>All classes</option>
                {classes.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <select className="f-select" value={specFilter} onChange={(e) => setSpecFilter(e.target.value)}>
                <option>All specs</option>
                {specs.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select className="f-select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                <option>All roles</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r === 'dps' ? 'DPS' : r.charAt(0).toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
              {isGearTab && (
                <select
                  className="f-select"
                  value={issueFilter}
                  onChange={(e) => setIssueFilter(e.target.value as IssueFilter)}
                >
                  {ISSUE_FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {f === 'All' ? 'All gear checks' : f}
                    </option>
                  ))}
                </select>
              )}
              <span className="filter-lbl" style={{ marginLeft: 10 }}>
                Sort
              </span>
              <select
                className="f-select"
                value={effectiveSortKey}
                onChange={(e) => {
                  const next = e.target.value as SortKey;
                  setSortKey(next);
                  // Time-of-death reads most naturally earliest-first;
                  // damage and parse, biggest first.
                  if (next === 'Time') setSortDir('asc');
                  else if (isDamageSort(next)) setSortDir('desc');
                }}
              >
                {SORT_KEYS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
                {activeTab === 'deaths' && <option>Time</option>}
                {activeTab === 'damage' && DAMAGE_SORT_KEYS.map((k) => <option key={k}>{k}</option>)}
              </select>
              <button
                type="button"
                className="sort-dir"
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
                aria-label={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          )}

          {activeTab === 'gearSummary' && (
            <div className="panel">
              <div className="table-scroll">
                <table className="s-table centered">
                  <thead>
                    <tr>
                      <th>Character</th>
                      <th>Overall</th>
                      <th>Enchant</th>
                      <th>Gem</th>
                      <th>Empty Slot</th>
                      {showShadowResist && <th>Shadow Resist</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {prepRows(result.gearIssues, { applyIssueFilter: true }).map((row) => {
                      const present = new Set(row.issues.map((i) => i.issueType));
                      const enchantOk = !present.has('noEnchant') && !present.has('weakEnchant');
                      const gemOk = !present.has('noGem') && !present.has('weakGem');
                      const emptyOk = !present.has('emptySlot');
                      // Only the Mother Shahraz fight has a raid-wide
                      // shadow-resist requirement; tanks are exempt there.
                      // Scoped to the encounter, not the zone, so the
                      // column and the Overall roll-up always agree.
                      const isBT = showShadowResist;
                      const isTank = roster.get(row.characterName)?.role === 'tank';
                      const srGear = srGearByName.get(row.characterName) ?? 0;
                      const srOk = !isBT || isTank || srGear >= BT_SHADOW_RES_THRESHOLD;
                      const overallOk = enchantOk && gemOk && emptyOk && srOk;

                      const mark = (ok: boolean, okTitle: string, failTitle: string) =>
                        ok ? (
                          <ReadyCheck title={okTitle} />
                        ) : (
                          <span className="fail-mark" title={failTitle}>
                            <i className="ni ni-fat-remove" />
                          </span>
                        );

                      return (
                        <tr key={row.characterName}>
                          <th scope="row">
                            <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                          </th>
                          <td>{mark(overallOk, 'Battle ready', 'Has outstanding gear checks')}</td>
                          <td>{mark(enchantOk, 'All enchants in order', 'Missing or weak enchants')}</td>
                          <td>{mark(gemOk, 'All gems in order', 'Missing or weak gems')}</td>
                          <td>{mark(emptyOk, 'No empty slots', 'Has empty gear slots')}</td>
                          {showShadowResist && (
                            <td>
                              {isBT && isTank && srGear < BT_SHADOW_RES_THRESHOLD ? (
                                <span
                                  className="tank-mark"
                                  title={`${srGear} shadow resistance from gear — tank, exempt from the ${BT_SHADOW_RES_THRESHOLD} requirement`}
                                >
                                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
                                    <path d="M8 0.8 L14 3.2 V7.4 C14 11.2 11.5 14.1 8 15.2 C4.5 14.1 2 11.2 2 7.4 V3.2 Z" />
                                  </svg>
                                </span>
                              ) : (
                                mark(
                                  srOk,
                                  isBT
                                    ? `${srGear} shadow resistance from gear — Mother Shahraz ready`
                                    : 'No shadow-resist requirement in this zone',
                                  `${srGear} shadow resistance from gear — needs ${BT_SHADOW_RES_THRESHOLD}+ for Mother Shahraz`
                                )
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'gearIssues' && (
            <div className="gear-card">
              {prepRows(result.gearIssues, { applyIssueFilter: true }).map((row) => (
                <div className={'char' + (row.issues.length === 0 ? ' clean' : '')} key={row.characterName}>
                  <div className="char-name">
                    <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                  </div>
                  {row.issues.length === 0 ? (
                    <div className="clean-note">No gear issues — fully enchanted &amp; gemmed ✦</div>
                  ) : (
                    <div className="slots">
                      {groupIssuesBySlot(row.issues).map((group) => (
                        <div className="slot-row" key={group.slot}>
                          <span className="slot-chip">{slotName(group.slot)}</span>
                          <div className="slot-detail">
                            {group.itemId === 0 ? (
                              <span className="issue-note">Empty</span>
                            ) : (
                              <span className="slot-item">
                                <WowheadItemLink itemId={group.itemId} itemName={group.itemName ?? ''} />
                              </span>
                            )}
                            {group.badges.map((b) => {
                              const note =
                                b.issueType === 'weakGem'
                                  ? weakGemNote(row.characterName, group.slot, b.currentValue)
                                  : b.currentValue;
                              return (
                                <span
                                  key={b.issueType}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
                                >
                                  <span className={`issue-tag ${ISSUE_TAG_CLASS[b.issueType]}`}>{b.label}</span>
                                  {note && <span className="issue-note">Currently: {note}</span>}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'deaths' && (
            <div className="panel">
              <div className="table-scroll">
                <table className="s-table centered">
                  <thead>
                    <tr>
                      <th>Character</th>
                      <th>Died?</th>
                      <th>Manner of Death</th>
                      <th>Time of Death</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prepRows(result.gearListings).map((row) => {
                      const deaths = deathsByName.get(row.characterName) ?? [];
                      return (
                        <tr key={row.characterName}>
                          <th scope="row">
                            <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                          </th>
                          <td>
                            {deaths.length === 0 ? (
                              <ReadyCheck title="Survived the fight" />
                            ) : (
                              <span className="death-mark" title={`Died ${deaths.length > 1 ? `${deaths.length} times` : 'once'}`}>
                                ☠
                              </span>
                            )}
                          </td>
                          <td>
                            {deaths.length === 0
                              ? '—'
                              : deaths.map((d, i) => (
                                  <div key={i}>{d.abilityName ?? 'Unknown'}</div>
                                ))}
                          </td>
                          <td>
                            {deaths.length === 0
                              ? '—'
                              : deaths.map((d, i) => <div key={i}>{fmtFightTime(d.timeMs)}</div>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'consumables' && (
            <div className="panel">
              <div className="table-scroll">
                <table className="s-table centered">
                  <thead>
                    <tr>
                      <th>Character</th>
                      <th>Score</th>
                      <th>B. Elixir</th>
                      <th>G. Elixir</th>
                      <th>Flask</th>
                      <th>Food</th>
                      <th>Scroll</th>
                      <th>Weapon Enh.</th>
                      <th>Pots/Lockrocks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prepRows(result.consumables).map((row) => (
                      <tr key={row.characterName}>
                        <th scope="row">
                          <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                        </th>
                        <td>{row.score.toFixed(2)}</td>
                        <td>{row.battleElixir ? <ReadyCheck /> : '—'}</td>
                        <td>{row.guardianElixir ? <ReadyCheck /> : '—'}</td>
                        <td>{row.flask ? <ReadyCheck /> : '—'}</td>
                        <td>{row.food ? <ReadyCheck /> : '—'}</td>
                        <td>{row.scroll ? <ReadyCheck /> : '—'}</td>
                        <td>{row.weaponEnhancement ? <ReadyCheck /> : '—'}</td>
                        <td>{row.potionUse > 0 || row.healthstoneUse > 0 ? <ReadyCheck /> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'drums' &&
            (result.drums.length === 0 ? (
              <div className="panel">
                <div className="panel-body dim">No drum usage detected.</div>
              </div>
            ) : (
              <div className="panel">
                <div className="table-scroll">
                  <table className="s-table centered">
                    <thead>
                      <tr>
                        <th>Character</th>
                        <th>Total drums</th>
                        <th>Buffs per drum</th>
                        <th>Pointless casts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prepRows(result.drums).map((row) => (
                        <tr key={row.characterName}>
                          <th scope="row">
                            <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                          </th>
                          <td>{row.totalDrums}</td>
                          <td>{row.buffsPerDrum.toFixed(2)}</td>
                          <td>{row.pointlessCasts}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

          {activeTab === 'damage' &&
            (result.damage.length === 0 ? (
              <div className="panel">
                <div className="panel-body dim">No damage data for this encounter.</div>
              </div>
            ) : (
              <div className="panel">
                <div className="table-scroll">
                  <table className="s-table centered">
                    <thead>
                      <tr>
                        <th>Character</th>
                        <th>Total Damage</th>
                        <th>DPS</th>
                        <th>% of Raid</th>
                        <th>Parse</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prepRows(result.damage).map((row) => (
                        <tr key={row.characterName}>
                          <th scope="row">
                            <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                          </th>
                          <td>{row.totalDamage.toLocaleString()}</td>
                          <td>{Math.round(row.dps).toLocaleString()}</td>
                          <td>{row.pctOfRaid.toFixed(1)}%</td>
                          <td>
                            {row.parsePercent === null || roster.get(row.characterName)?.role === 'healer' ? (
                              // Healers are ranked here on damage, against
                              // other healers — a high number for doing
                              // almost none, so it is withheld.
                              <span
                                className="dim"
                                title={
                                  roster.get(row.characterName)?.role === 'healer'
                                    ? 'Damage parse is not meaningful for healers'
                                    : result.kill
                                      ? 'Not ranked, or rankings hidden on Warcraft Logs'
                                      : 'Only kills are ranked'
                                }
                              >
                                —
                              </span>
                            ) : (
                              <span
                                className="parse"
                                style={{ color: parseColor(row.parsePercent) }}
                                title={`${ordinal(Math.floor(row.parsePercent))} percentile on Warcraft Logs`}
                              >
                                {Math.floor(row.parsePercent)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

          {activeTab === 'shadowResistance' && (
            <div className="panel">
              <div className="table-scroll">
                <table className="s-table centered">
                  <thead>
                    <tr>
                      <th>Character</th>
                      <th>BT Minimum?</th>
                      <th>From gear</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prepRows(result.shadowResistance).map((row) => {
                      const isTank = roster.get(row.characterName)?.role === 'tank';
                      return (
                        <tr key={row.characterName}>
                          <th scope="row">
                            <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                          </th>
                          <td>
                            {row.srFromGear >= BT_SHADOW_RES_THRESHOLD ? (
                              <ReadyCheck title={`${row.srFromGear} shadow resistance from gear — Mother Shahraz ready`} />
                            ) : isTank ? (
                              // Tanks are exempt from the Shahraz SR
                              // requirement — shielded, not shamed.
                              <span
                                className="tank-mark"
                                title={`${row.srFromGear} shadow resistance from gear — tank, exempt from the ${BT_SHADOW_RES_THRESHOLD} requirement`}
                              >
                                <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
                                  <path d="M8 0.8 L14 3.2 V7.4 C14 11.2 11.5 14.1 8 15.2 C4.5 14.1 2 11.2 2 7.4 V3.2 Z" />
                                </svg>
                              </span>
                            ) : (
                              <span
                                className="death-mark"
                                title={`${row.srFromGear} shadow resistance from gear — needs ${BT_SHADOW_RES_THRESHOLD}+ for Mother Shahraz`}
                              >
                                ☠
                              </span>
                            )}
                          </td>
                          <td>{row.srFromGear}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'gearListing' && (
            <div className="gear-card">
              {prepRows(result.gearListings).map((row) => {
                const bySlot = new Map(
                  row.gear
                    .filter((item) => item.id !== 0 && item.name && !GEAR_HIDDEN_SLOTS.has(item.slot))
                    .map((item) => [item.slot, item])
                );

                const renderSlot = (slot: number) => {
                  const item = bySlot.get(slot);
                  if (!item) return null;
                  // WCL's permanentEnchantName is the retail name for the
                  // effect id — resolve the real TBC name from the lookup
                  // table, falling back to WCL's only when unknown.
                  const enchantLabel = item.permanentEnchant
                    ? (enchantNames.get(item.permanentEnchant) ?? item.permanentEnchantName)
                    : item.permanentEnchantName;
                  return (
                    <div className="gear-slot" key={slot}>
                      <span className="slot-chip">{slotName(slot)}</span>
                      <div className="gear-item">
                        <WowheadItemLink itemId={item.id} itemName={item.name} />
                        {enchantLabel && <div className="ench">+ {enchantLabel}</div>}
                        {(item.gems ?? []).length > 0 && (
                          <div className="gems">
                            {(item.gems ?? []).map((gem, i) => {
                              const info = gemInfo.get(gem.id);
                              const tint = info
                                ? (info.color ? GEM_SOCKET_COLORS[info.color] : undefined) ??
                                  QUALITY_COLORS[info.quality]
                                : undefined;
                              const tooltip = info
                                ? `${info.name ?? 'Unknown gem'} — ${info.quality}${info.color ? ` ${info.color}` : ''} gem`
                                : 'Unknown gem — view on Wowhead';
                              return (
                                <a
                                  key={i}
                                  className="gem-dot"
                                  href={`https://www.wowhead.com/tbc/item=${gem.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={tint ? { color: tint } : undefined}
                                  title={tooltip}
                                >
                                  ◆
                                </a>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                };

                const renderCols = ([left, right]: [number[], number[]]) => (
                  <div className="gear-cols">
                    <div className="gear-col">{left.map(renderSlot)}</div>
                    <div className="gear-col">{right.map(renderSlot)}</div>
                  </div>
                );

                return (
                  <div className="char" key={row.characterName}>
                    <div className="char-name">
                      <CharacterCell name={row.characterName} meta={roster.get(row.characterName)} />
                    </div>
                    <div className="gear-block">
                      {renderCols(GEAR_LAYOUT_TOP)}
                      <hr className="gear-rule" />
                      {renderCols(GEAR_LAYOUT_BOTTOM)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'validation' &&
            (result.validation ? (
              <div className="panel">
                <div className="panel-body" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                  <span
                    className={`tag-pill ${result.validation.isValid ? 'kill' : 'wipe'}`}
                    style={{ marginLeft: 0, marginRight: 10 }}
                  >
                    {result.validation.isValid ? 'VALID' : 'NOT VALID'}
                  </span>
                  {result.validation.zone} — {result.validation.bossesKilled}/{result.validation.bossesRequired}{' '}
                  requirements met
                </div>
                <div className="table-scroll">
                  <table className="s-table centered">
                    <thead>
                      <tr>
                        <th>Requirement</th>
                        <th>Required</th>
                        <th>Actual</th>
                        <th>Met?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.validation.details.map((d) => (
                        <tr key={d.bossName}>
                          <th scope="row">{d.bossName}</th>
                          <td>{d.minKills}</td>
                          <td>{d.actualKills}</td>
                          <td>
                            {d.passed ? (
                              <ReadyCheck title="Requirement met" />
                            ) : (
                              <span className="fail-mark" title="Requirement not met">
                                <i className="ni ni-fat-remove" />
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="panel">
                <div className="panel-body dim">No validation data (report doesn't match a known raid zone).</div>
              </div>
            ))}
        </>
      )}
    </>
  );
}
