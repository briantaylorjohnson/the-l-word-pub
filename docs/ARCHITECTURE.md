# Architecture

How **The L Word** fits together: a React frontend on AWS Amplify Hosting, an Amplify Gen 2 backend
(Cognito, AppSync, DynamoDB, Lambda), fed by the Warcraft Logs (WCL) API. The diagrams are
[Mermaid](https://mermaid.js.org/) — GitHub renders them, and they live in the repo so they version
with the code.

See also: [`API.md`](API.md) (every call), [`OPERATIONS.md`](OPERATIONS.md) (deploy and backfill),
and the [README](../README.md) (status and implementation notes).

## 1. System overview

```mermaid
flowchart TB
  B["Browser<br/>React + Vite"]
  H["Amplify Hosting<br/>builds from GitHub main"]
  C["Cognito<br/>user pool + guest identity pool"]
  AS["AppSync GraphQL API"]

  subgraph LAM["Lambda functions"]
    IR["ingest-report<br/>admin trigger"]
    IW["ingest-report-worker<br/>async ingest"]
    WC["wcl-client<br/>WCL adapter"]
    DR["delete-report<br/>cascade delete"]
  end

  SM[("SSM secrets<br/>wclApiKey, wclClientId, wclClientSecret")]
  WCL[["Warcraft Logs<br/>v1 REST + v2 GraphQL"]]

  subgraph DDB["DynamoDB - 22 tables"]
    REF[("Reference data<br/>11 tables")]
    ENC[("Encounter results<br/>8 tables")]
    RAID[("Raid summaries<br/>RaidNight, ValidationResult, IngestStatus")]
  end

  H -->|serves the app| B
  B -->|admin sign-in| C
  B -->|GraphQL| AS
  C -.->|authorizes| AS
  AS -->|reads| DDB
  AS -->|ingestReport| IR
  AS -->|deleteReportCascade| DR
  IR -->|fight list| WC
  IR -->|async invoke| IW
  IW -->|many calls| WC
  WC -->|API calls| WCL
  WC -->|reads keys| SM
  IW -->|reads| REF
  IW -->|writes| ENC
  IW -->|writes| RAID
  DR -->|deletes| ENC
  DR -->|recomputes| RAID
```

**Auth.** Anyone can read (the identity pool's guest role); only the `admins` Cognito group can write
or call the two custom mutations. The browser reads through AppSync; the Lambdas write straight to
DynamoDB over IAM (see the README's "Writing directly to DynamoDB").

**Why the trigger/worker split.** AppSync resolvers are capped at 30 seconds, and a full raid night
needs well over a thousand WCL calls. `ingest-report` only fetches the fight list and fires
`ingest-report-worker` asynchronously (`InvocationType: Event`); encounters then appear in the list as
the worker finishes each one.

**Why `wcl-client` is its own Lambda.** It is the only code that knows WCL's request and response
shapes, so a change to WCL's API is a change to one file. It also owns the three secrets.

## 2. Table relationships

All 22 tables are listed in the README. The 11 reference tables (`ItemSocket`, `ShadowResistanceItem`,
`ShadowResistanceEnchant`, `CharacterRace`, `SuboptimalEnchant`, `ExcludedGearItem`, `GemQuality`,
`EnchantName`, `ItemName`, `RaidValidationRule`, `ConsumableBuff`) are looked up by item, enchant,
gem or zone id, so they have no foreign keys. The tables that *do* relate:

```mermaid
erDiagram
  RaidNight ||--|{ Report : "has encounters"
  RaidNight ||--o| ValidationResult : "one per report"
  RaidNight ||--o| IngestStatus : "one per report"
  Report ||--o{ GearListing : "per player"
  Report ||--o{ GearIssue : "per player"
  Report ||--o{ ConsumableScore : "per player"
  Report ||--o{ DrumStat : "per player"
  Report ||--o{ DamageStat : "per player, boss fights"
  Report ||--o{ DeathRecord : "per player"
  Report ||--o{ ShadowResistanceResult : "per player"

  RaidNight {
    string reportCode PK
    string listKey "date index partition"
    datetime fightDate "date index sort"
    int bossCount
    int killAttempts
    int wipeAttempts
    json deathEvents
    json classes
    json critByFight
    json topCritDamage
    json topCritHeal
  }
  Report {
    string reportCode PK
    string fightId PK
    string encounterName
    boolean isBossEncounter
    boolean kill
    datetime fightDate
    string encounterGroupKey
  }
  GearListing {
    string reportCode PK
    string fightId PK
    string characterName PK
    json gear
    string characterClass
    string role
  }
  GearIssue {
    string reportCode PK
    string fightId PK
    string characterName PK
    json issues
  }
  ConsumableScore {
    string reportCode PK
    string fightId PK
    string characterName PK
    int score
  }
  DrumStat {
    string reportCode PK
    string fightId PK
    string characterName PK
    int totalDrums
  }
  DamageStat {
    string reportCode PK
    string fightId PK
    string characterName PK
    int totalDamage
    float dps
    float pctOfRaid
    float parsePercent
  }
  DeathRecord {
    string reportCode PK
    string fightId PK
    string characterName PK
    json deaths
  }
  ShadowResistanceResult {
    string reportCode PK
    string fightId PK
    string characterName PK
    int srTotal
  }
  ValidationResult {
    string reportCode PK
    boolean isValid
  }
  IngestStatus {
    string reportCode PK
    int encountersFailed
  }
```

`reportCode` is the Warcraft Logs report id. `fightId` is one row per *encounter*: a real WCL fight id
for a boss attempt, or `trash-<firstId>-<lastId>` for a merged trash gap. The three-field tables are
stored with hash key `reportCode` and range key `fightId#characterName`.

`RaidNight` is a **derived** summary, rebuilt from the other tables after every ingest and delete. It is
what the Raid Reports list pages through and what the Hall of Records sums (sections 4 and 5).

## 3. Ingesting a raid

```mermaid
sequenceDiagram
  autonumber
  participant A as Admin browser
  participant AS as AppSync
  participant IR as ingest-report
  participant IW as ingest-report-worker
  participant WC as wcl-client
  participant W1 as WCL v1
  participant W2 as WCL v2
  participant D as DynamoDB

  A->>AS: ingestReport(reportCode)
  AS->>IR: invoke
  IR->>WC: getReportFights
  WC->>W1: /report/fights
  IR--)IW: async invoke (Event)
  IR-->>AS: title, zone, fightCount
  AS-->>A: returns immediately

  loop each boss attempt and trash window
    IW->>WC: summary, buffs per player, events, damage-done
    WC->>W1: report tables and events
    W1-->>IW: data
    Note over IW,D: all WCL data for the fight is fetched BEFORE its rows are cleared
    IW->>D: clear then write the fight's rows
  end

  IW->>WC: getFightRankings (one query for every kill)
  WC->>W2: report.rankings
  IW->>D: set parsePercent on DamageStat
  IW->>WC: getFightCrits (damage and healing)
  WC->>W2: report.events, isCritical, paged
  W2-->>IW: best crit per fight
  IW->>D: recompute RaidNight rollup
  IW->>D: write IngestStatus and ValidationResult
```

Failure handling: a failed fight is logged and skipped (and counted in `IngestStatus`); the parse and
crit steps are best-effort and never fail an ingest. See the README's "Worker modes" for the cheaper
re-run modes (`parsesOnly`, `raidNightOnly`, `critsOnly`).

## 4. Raid Reports list

```mermaid
flowchart LR
  L["Raid Reports page"] -->|"raidNightsByDate<br/>limit 15, newest first"| RN[("RaidNight")]
  RN -->|"15 raid summaries<br/>+ nextToken"| L
  L -->|"Load 15 more"| RN
  L -->|"expand a raid:<br/>query by reportCode"| RP[("Report")]
  RP -->|"that raid's encounters"| L
```

Collapsed headers render from `RaidNight` alone; encounters are fetched only when a raid is expanded.
Zone and search are server-side filters, so they span every page.

## 5. Hall of Records

```mermaid
flowchart LR
  subgraph WRITE["On every ingest and delete"]
    RPT[("Report, DeathRecord,<br/>GearListing")] --> RC["recomputeRaidNight"]
    WCLV2["WCL v2 crit records"] --> RC
    RC --> RN[("RaidNight<br/>one row per raid")]
  end

  subgraph READ["On every page load"]
    LS[("localStorage cache")] -->|"paint immediately"| SB["Sidebar"]
    RN -->|"1 query, slim selectionSet"| FH["fetchHallRows"]
    FH -->|"refresh cache"| LS
    FH --> CM["computeMetrics<br/>sums rows, applies Phase 3 reset"]
    CM --> SB
  end
```

Each `RaidNight` row carries that raid's own contribution to every record, so the sidebar sums ~44 small
rows instead of scanning ~19,000 items. Before this design the Hall took about 17 seconds and 72 requests
to appear; it is now one request, and repeat visits paint from the cache first. Crit records come from WCL
and are carried forward across recomputes (`critByFight`), because they cannot be rebuilt from DynamoDB.
Details and definitions are in the README's "Hall of Records" section.
