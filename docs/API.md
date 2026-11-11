# API reference

Everything the app exposes or consumes, in three layers: the public GraphQL API the browser calls,
the internal Lambda interfaces, and the external Warcraft Logs (WCL) calls. For how they connect, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. GraphQL API (AppSync) — what the browser calls

Defined in `amplify/data/resource.ts`. **Auth:** the default authorization mode is the Cognito identity
pool, so every visitor reads as a *guest*. A signed-in admin is in the `admins` group and additionally
gets writes and the two custom mutations. `src/readAuthMode.ts` passes `userPool` for signed-in users
and nothing (the default) otherwise.

### Generated per model (22 models)

For each model Amplify generates `get`, `list`, `create`, `update` and `delete`
(`dataClient.models.<Model>.<op>`), plus subscriptions that the app does not use. Guests may only
`get`/`list`; writes require the `admins` group.

- `list` accepts `filter`, `limit`, `nextToken`, `authMode` and `selectionSet`. It is a **table scan with
  a filter**, so a page can come back short or empty with a `nextToken` still pending — always follow the
  token to the end (`src/listAll.ts`).
- A keyed list for one raid — `dataClient.models.Report.list({ reportCode, ... })` — is a fast partition
  query. The installed generated types do not expose key arguments on `list()` for this model, so the
  call is cast (`ReportsList.tsx`).

### Custom operations

| Operation | Kind | Arguments | Returns | Auth |
|---|---|---|---|---|
| `ingestReport` | mutation | `reportCode: String!`, `baseUrl: String` | `{ title, zone, fightCount }` | `admins` |
| `deleteReportCascade` | mutation | `reportCode: String!`, `fightId: String!` | `{ success }` | `admins` |
| `RaidNight.raidNightsByDate` | indexed query | `{ listKey }`, `sortDirection`, `filter`, `limit`, `nextToken`, `selectionSet` | `RaidNight` rows, ordered by `fightDate` | anyone |

`deleteReportCascade` is named that because Amplify already generates a `deleteReport` for the `Report`
model; a custom mutation sharing a model's CRUD verb silently shadows it.
`raidNightsByDate` is the secondary index on `RaidNight` (`listKey` partition, `fightDate` sort). It is
not called `listRaidNights` because that collides with the query Amplify generates for the model.

### What the UI calls

| Screen | Calls |
|---|---|
| Raid Reports list | `RaidNight.raidNightsByDate` (15 per page); `Report.list({ reportCode })` when a raid is expanded; `deleteReportCascade` (admin) |
| Report detail | `Report.get`; `list` on `GearListing`, `GearIssue`, `ConsumableScore`, `DrumStat`, `DamageStat`, `DeathRecord`, `ShadowResistanceResult`, `GemQuality`, `EnchantName`; `ValidationResult.get` |
| Sidebar (Hall of Records) | `RaidNight.raidNightsByDate` — **one request** with a slim `selectionSet` (see `src/hallOfRecords.ts`) |
| Admin ingest | `ingestReport`; `IngestStatus.get` |

## 2. Lambda interfaces (internal)

None of these are public; AppSync or another Lambda invokes them.

### `wcl-client` — action-dispatched, event `{ action, ..., baseUrl? }`

| Action | Parameters | Returns |
|---|---|---|
| `getReportFights` | `reportCode` | WCL fights response: title, zone, start, fights, friendlies |
| `getSummaryTable` | `reportCode`, `start`, `end` | v1 summary table (player gear, talents, deaths) |
| `getTable` | `view`, `reportCode`, `start`, `end`, `extraParams?` | v1 table for the view (`buffs`, `damage-done`, ...) |
| `getEvents` | `reportCode`, `start`, `end`, `filter?`, `extraParams?` | v1 events (one page) |
| `getFightRankings` | `reportCode`, `fightIds[]` | v2 rankings: per-fight roles, characters and `rankPercent` |
| `getFightCrits` | `reportCode`, `fightIds[]` | `{ damage, healing }`: each a map `fightId -> { name, sourceID, amount, overheal?, ability, timestamp }` — the best single crit per fight |
| `getParses` | `characterName`, `serverSlug`, `region`, `extraParams?` | v1 parses; **no longer used by ingest** |

`baseUrl` defaults to `https://classic.warcraftlogs.com/v1`; the v2 site root is derived from it.
`getFightCrits` pages `nextPageTimestamp` internally and resolves player names itself, so its response is
a couple of KB however large the raid.

### `ingest-report` — event `{ arguments: { reportCode, baseUrl? } }`
Fetches the fight list via `wcl-client`, starts the worker asynchronously, and returns
`{ title, zone, fightCount }` immediately.

### `ingest-report-worker` — event `{ reportCode, baseUrl?, parsesOnly?, raidNightOnly?, critsOnly? }`

| Event | Does | Returns |
|---|---|---|
| `{ reportCode }` | Full ingest of every encounter | `{ reportCode, encountersProcessed, encountersFailed }` |
| `+ parsesOnly: true` | Refreshes `DamageStat.parsePercent` from v2 | `{ reportCode, parsesOnly, killsConsidered }` |
| `+ raidNightOnly: true` | Rebuilds the `RaidNight` rollup, no WCL | `{ reportCode, raidNightOnly }` |
| `+ critsOnly: true` | Refreshes crit records from v2, then the rollup | `{ reportCode, critsOnly, fightsConsidered, fightsWithCrits }` |

### `delete-report` — event `{ arguments: { reportCode, fightId } }`
Deletes that encounter's rows from every per-fight table and the `Report` row, recomputes `RaidNight`
(removing it when no boss attempt remains), and removes `ValidationResult` once no `Report` rows remain.
Returns `{ success: true }`.

## 3. Warcraft Logs calls (external)

### v1 REST — `https://classic.warcraftlogs.com/v1`, API key
| Endpoint | Used for |
|---|---|
| `/report/fights/{code}` | Fight list, friendlies, title, zone |
| `/report/tables/summary/{code}` | Per-player gear, talents and deaths per encounter window |
| `/report/tables/buffs/{code}` (`targetid`) | Which consumable/aura buffs each player had |
| `/report/tables/damage-done/{code}` | Per-player damage for each boss fight |
| `/report/events/{code}` (`type="cast"`, `type="applybuff"`) | Drum casts and the buffs they landed |
| `/parses/character/{name}/{server}/{region}` | Not used by ingest (incomplete) |

### v2 GraphQL — `https://classic.warcraftlogs.com/api/v2/client`, OAuth
| Call | Used for |
|---|---|
| `POST /oauth/token` (client credentials) | Access token, cached per warm container, refreshed once on 401 |
| `reportData.report(code).rankings(fightIDs, playerMetric: dps)` | Parse percentiles for every kill, one query |
| `reportData.report(code).events(dataType: DamageDone \| Healing, fightIDs, filterExpression: "isCritical = true and source.type = \"Player\"", useAbilityIDs: false, limit: 10000)` | Crit records; follow `nextPageTimestamp` |
| `masterData.actors(type: "Player")` | Resolve `sourceID` to player names |

v2 allows 9,000 points per hour and each query above costs about 1.

### Calls per ingest
Per fight: 1 summary, ~25 buffs (one per player), 2 events, plus 1 `damage-done` for boss fights.
Per report: 1 fight list (v1), and 3 v2 queries (rankings, crit damage, crit healing — plus extra pages
for the crit queries on a large night). The crit records add **no v1 calls**.

## 4. Other outbound links (not API calls)

Wowhead item links, Classic Armory character links, and the Classic Armory avatar image URL in the
sidebar credit. The offline seed scripts read public GitHub data files (`wowsims/tbc`, `wowaudit/core`).
