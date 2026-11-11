# The L Word — Combat Log Analytics

A rebuild of a WoW Classic TBC raid-analysis tool as a real web app: React frontend,
AWS Amplify Gen 2 backend (Cognito + AppSync + DynamoDB + Lambda), fed by the
WarcraftLogs API.

The original tool was a Google Sheet ("Combat Log Analytics") whose Apps Script pulled
a WarcraftLogs report and cross-referenced it against enchant/gem/shadow-resistance/
raid-validation reference tables to flag gearing, consumable, and log-validity issues
per raider. This project reimplements that pipeline as a proper backend + frontend
instead of a spreadsheet.

Documentation lives in [`docs/`](docs/):

| Doc | What's in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System diagram, table relationships, the ingest sequence and the Hall of Records data flow (Mermaid, rendered by GitHub) |
| [`docs/API.md`](docs/API.md) | Every GraphQL operation, Lambda interface and Warcraft Logs call the app makes |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Deploy order, backfill modes, rate limits, cost notes, troubleshooting |

This README tracks build *status* and the hard-won implementation notes; the `docs/` files describe
how the system fits together.

> **Keep this file and `docs/` updated** as work continues — they're the single source of truth for
> "what's actually done" versus "what's planned." `npm run docs:check` verifies the facts below
> (model count, tabs, secrets, Lambda actions) against the code.

## Status

| # | Task | Status |
|---|---|---|
| 1 | Amplify Gen 2 scaffold (Auth + Data schema) | ✅ Done |
| 2 | Seed `ItemSocket` + `ShadowResistanceItem` | ✅ Done |
| 3 | Seed `SuboptimalEnchant` + `ExcludedGearItem` + `RaidValidationRule` | ✅ Done |
| 4 | `wclClient` Lambda (WCL v1 REST adapter) | ✅ Done — validated end-to-end against a real report |
| 5 | `ingestReport` + `gearIssues` + gear pages | ✅ Done — verified in-browser against a real ingested report |
| 6 | `validate.ts` rule + `ValidationResult` page | ✅ Done — verified against a real report (SSC, 6/6 requirements, valid) |
| 7 | `consumables`/`drums`/`shadowResistance` rules + pages | ✅ Done — verified against a real report (see below for confidence levels) |
| 8 | Admin ingest screen + Discord webhook | ✅ Done (ingest screen) — Discord webhook explicitly deferred, not built |
| 9 | Public `/reports` list + tabbed view + `deleteReport` | ✅ Done — cascade delete verified against a real report (all 7 tables emptied, then re-ingested) |
| 10 | UI theme + logo | ✅ Done — originally Argon Dashboard; since replaced wholesale by the hand-written **Sanctum** design system (see "UI styling") |
| 11 | Ingest a whole raid by report code (no fight id) | ✅ Done — verified against two independently-ingested live reports (SSC: 15 rows, TK: 13 rows), both matching hand-calculated expected encounter counts; see "Ingesting a whole raid" below |
| 12 | Damage tab: total damage, DPS, % of raid damage, WCL parse | ✅ Done — live; parse coverage 211 of 211 kills with damage data |
| 13 | Warcraft Logs **v2** (OAuth) client — per-fight parse rankings and crit records | ✅ Done — see "Warcraft Logs integration" |
| 14 | Raid Reports pagination (15 raids per request, "Load 15 more") via the `RaidNight` summary table | ✅ Done — live |
| 15 | Hall of Records rebuilt on `RaidNight` rollups (+ Highest Damage / Healing Crit, boss and date shown) | ✅ Done — live |

**The original 11 tasks are done; 12-15 are live.**

**Deployed AWS backend:** a sandbox environment is live in your AWS account (`<your-aws-account-id>`), region
`us-east-1`, under the `theLWord` AWS CLI profile. Its identifier is whatever the OS
username is on the deploying machine (unsanitized, e.g. `first-last`) — see the `--identifier`
warning under "Local development" below before ever passing that flag explicitly.

## Repo layout

```
amplify/            Backend: Auth (Cognito), Data (AppSync + DynamoDB), Functions (Lambda)
  backend.ts                   Wires IAM grants + TABLE_NAME_* env vars between functions and tables
  auth/resource.ts             Cognito user pool, "admins" group
  data/resource.ts             All 22 DynamoDB models, the two custom mutations, authorization rules
  functions/wcl-client/        Warcraft Logs adapter: v1 REST (API key) + v2 GraphQL (OAuth) — the only code that knows WCL
  functions/ingest-report/            Fast trigger: fetches the fight list, hands off to the worker
  functions/ingest-report-worker/     Does the actual work — see "Ingesting a whole raid" below
    rules/groupEncounters.ts            Groups WCL fights into boss attempts + trash gaps
    rules/gearIssues.ts, validate.ts, consumables.ts, drums.ts, shadowResistance.ts, damage.ts
  functions/delete-report/            Cascading delete of one encounter + summary recompute
  functions/_shared/raidNight.ts      Builds the per-raid RaidNight rollup row (list fields + Hall of Records fields)
src/                 React (Vite) frontend
  App.tsx            Route table: "/" reports list, "/reports/:reportCode/:fightId" detail, "/admin" ingest
  Layout.tsx          App shell (Sidebar + <Outlet/>), wraps every route
  Sidebar.tsx          Nav, the Hall of Records, and the credit block
  hallOfRecords.ts     Hall data: one RaidNight query, localStorage cache, and the record maths
  PageHeader.tsx       The title band each page renders at its top
  ReportsList.tsx      Public list of raids, 15 per request with "Load 15 more"; admin-only delete icon
  ReportDetail.tsx     Public tabbed view of one encounter (Damage, Gear Check Summary, Gear Issues, Deaths, ...)
  AdminIngest.tsx     Login-gated ingest form (Cognito Authenticator + the ingestReport mutation)
  featureFlags.ts      Compile-time flags (the Phase 3 Most Deaths reset)
  parseColors.ts       Warcraft Logs parse-tier colours and ordinals
  links.tsx, classColors.ts, slotNames.ts, listAll.ts, readAuthMode.ts, useIsAdmin.ts   Small shared helpers
  assets/css/sanctum.css   The whole design system (one hand-written file; see "UI styling")
docs/                Architecture, API reference, operations runbook
scripts/seed/        One-off data migration: source spreadsheets and public datasets -> DynamoDB
  extract_reference_data.py, extract_external_reference_data.py   sockets, shadow resistance, enchants, excluded gear, validation rules
  scrape_gem_qualities.py, scrape_enchant_names.py, scrape_item_names.py   gem tiers, real TBC enchant names, 20k item names
  load_to_dynamodb.mjs                generic loader: seed JSON -> live DynamoDB table
  data/*.json          generated seed data (safe to regenerate, not hand-edited)
scripts/docs-check.mjs   Asserts the facts in these docs against the code (npm run docs:check)
```

## UI styling

The frontend uses **Sanctum**, a hand-written design system in a single file,
`src/assets/css/sanctum.css`. It replaced the original Argon Dashboard / Bootstrap bundle
wholesale (the Argon SCSS tree, `reactstrap`-era class names and `bootstrap` dependency are
gone); every class the app uses is defined there.

- **Look:** dark-fantasy, sampled from the guild crest — arcane violet and burnished gold on
  near-black obsidian. Design tokens (`--bg`, `--gold`, `--line`, `--text-dim`, class colours, ...)
  are CSS custom properties at the top of the file; headings use Cinzel (loaded in `index.html`)
  and body text a system serif/sans stack.
- **Layout:** a fixed-width left sidebar (crest, nav, Hall of Records, sticky credit block) beside
  a content column, with a single page scrollbar — the sidebar has no scroll container of its own.
- **Class colours:** `src/classColors.ts` holds the Blizzard class colours; character names are
  coloured by class wherever the class is known. Parse values use Warcraft Logs' own tier colours
  (`src/parseColors.ts`).
- **Icons:** the vendored Nucleo icon font (`src/assets/plugins/nucleo`, `ni ni-*` classes).
- **Motion:** animations are wrapped in `prefers-reduced-motion: no-preference`.
- **The `/admin` sign-in form** (`@aws-amplify/ui-react`'s `<Authenticator>`) is re-themed in the
  same file by overriding the `--amplify-colors-primary-*` scale under `[data-amplify-theme]`.
  This only works because `@aws-amplify/ui-react/styles.css` is imported in `main.tsx` *before*
  our CSS — custom properties resolve last-declaration-wins, so our overrides must load after
  Amplify's base theme.
- **Tab strip:** wraps onto a second row instead of scrolling — a scrollbar would hide the later tabs.

## Data model

**22 DynamoDB models** (defined in `amplify/data/resource.ts`), in three groups. For how they
relate, see the ER diagram in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Reference tables (11)** — looked up by item / enchant / gem id, seeded by scripts, rarely change:

| Table | Key | Source / purpose |
|---|---|---|
| `ItemSocket` | `itemId` | CLA workbook's `sockets` tab — socket count per item |
| `ShadowResistanceItem` | `itemId` | CLA workbook's `shadow resistance config` tab |
| `ShadowResistanceEnchant` | `enchantId` | Shadow-resistance value + name per enchant |
| `CharacterRace` | `characterName` | Race per character (racial resistances) |
| `SuboptimalEnchant` | `enchantId`, `slot` | External workbook's `suboptimalEnchants` tab — enchants flagged as weak |
| `ExcludedGearItem` | `itemId` | Vanity/proc items (fishing poles etc.) excluded from gear checks |
| `GemQuality` | `itemId` | Gem tier + colour, from the public `wowsims/tbc` data (`scrape_gem_qualities.py`) |
| `EnchantName` | `enchantId` | Real TBC enchant names (WCL returns retail names; `scrape_enchant_names.py`) |
| `ItemName` | `itemId` | ~20k equippable item names; WCL sometimes omits them, and the worker self-heals this table |
| `RaidValidationRule` | `zone`, `bossName` | External workbook's `validate*Log` tabs |
| `ConsumableBuff` | `spellId`, `category` | External workbook's `buffConsumables` tab |

**Per-encounter tables (8)** — written by `ingest-report-worker`, one set of rows per encounter:

`Report`, `GearListing`, `GearIssue`, `ConsumableScore`, `DrumStat`, `DamageStat`, `DeathRecord`,
`ShadowResistanceResult` — keyed by `reportCode` + `fightId` (+ `characterName` where per-raider).
`fightId` means "one row per *encounter*" (see below), not literally one WCL fight id: a real WCL
fight id string for a boss attempt (e.g. `"7"`), or a synthesized `"trash-<firstId>-<lastId>"` for a
merged trash-gap row. `Report` additionally carries `encounterName`, `isBossEncounter`, `kill`
(null for trash) and `encounterGroupKey` (shared by every attempt on the same boss, null for trash)
— see "Ingesting a whole raid" below. `DamageStat` is written for boss encounters only and carries
total damage, DPS, share of raid damage and the Warcraft Logs parse percentile.

**Per-report tables (3)** — keyed by `reportCode` **alone**, one shared row per raid night:

- `ValidationResult` — log validity is a property of the whole raid night, not any one encounter.
- `IngestStatus` — how many encounters the last ingest processed or failed, and the errors, so a
  partial ingest is visible to the admin instead of only in CloudWatch.
- `RaidNight` — a **derived summary** of the raid, rebuilt from the other tables after every ingest
  and delete (`functions/_shared/raidNight.ts`). It backs both the paged Raid Reports list and the
  Hall of Records (see those sections). It has a date index, `raidNightsByDate`, partitioned by a
  constant `listKey` so the list can query "newest first".

All tables are public-read (any visitor, signed in or not) and admin-write (Cognito
`admins` group). `ingestReport`/`ingest-report-worker` is the actual write path;
`deleteReportCascade` is the only other.

**Gotcha: public reads break for a signed-in admin, and `allow.authenticated()` does NOT
fix it on this installed Amplify Data version.** The frontend's read calls (`Report.list()`,
etc.) all use the client's default authMode (`identityPool`) with no per-call override.
`identityPool` resolves to the Identity Pool's *unauthenticated* IAM role for a signed-out
visitor, but its *authenticated* IAM role for anyone signed in — including an admin who
just logged in to use `/admin`. With only `allow.guest()` on these models, every public
read broke the instant an admin signed in (`allow.group('admins')` doesn't cover it either
— that rule only applies over Cognito User Pool auth, which these default-authMode reads
never use).

The obvious fix — add `allow.authenticated().to(['read'])` alongside `allow.guest()` —
looked right and even changed the deployed IAM policy (the authenticated role gained
`appsync:GraphQL` on every model's type), but reads **still** came back `Unauthorized` for
a signed-in admin. Root-caused by pulling the actual deployed resolver's authorization
template (`aws appsync get-function` on `QuerylistReportsauth0Function`) and reading the
generated VTL directly: the IAM-auth branch only ever compares the caller's role ARN
against `$ctx.stash.unauthRole`. There's no corresponding `authRole` stash check —
`allow.authenticated()` never wires into it. Confirmed by testing directly against the
deployed API (bypassing the browser entirely — signed in via `aws-amplify/auth`'s own
`signIn()` in a Node script, then called `Report.list()` the same way the frontend does):
still `Unauthorized`, identical error, with or without `allow.authenticated()` in the
schema. Removed it — a no-op that would mislead a future reader into thinking the fix
lives in the schema.

The **same investigation also found the real fix**, by accident: the same script called
with `{ authMode: 'userPool' }` explicitly on the read succeeded immediately — 5 reports,
no errors. Turns out the User Pool auth branch of that same generated resolver
authorizes *any* signed-in caller for these read-only fields (the actual admin-group check
in that branch is unreachable dead code — `isAuthorized` gets force-set `true` right before
it). So the real fix is client-side, not schema-side: `src/readAuthMode.ts` checks whether
a real Cognito session exists (`fetchAuthSession()` returns tokens) and returns `'userPool'`
if so, `undefined` (client default, i.e. `identityPool`) if not — `userPool` mode throws
("No federated jwt") if attempted with no session at all, so it can't just be used
unconditionally. Every read call in `ReportsList.tsx` and `ReportDetail.tsx` now passes
`authMode: await getReadAuthMode()`. Verified against the real deployed API for both a
signed-out session (28 reports via the default/guest path) and a signed-in admin session
(28 reports via the `userPool` path) — via a throwaway Cognito test account created, used,
and deleted for this diagnosis, never the real admin account.

**Second, separate gotcha found while fixing the one above: `list()` calls need to follow
`nextToken` to exhaustion, always — a filtered page can come back with zero items and still
have more pages.** After the authMode fix, the Reports list worked but `ReportDetail.tsx`'s
tabs (gear issues, consumables, drums, shadow resistance, gear listing) still showed
nothing for a signed-in admin. Not an auth bug this time — reproduced directly against the
deployed API again and found `GearIssue.list({ filter: {reportCode, fightId} })` took **5
pages** (400 items scanned, `limit: 100` each) before any of the 25 matching rows showed
up. `DrumStat.list()` happened to work by luck earlier in this same investigation — that
table just has far fewer total rows campaign-wide, so its matches fit on page one. The
`limit` argument on a DynamoDB Scan+`FilterExpression`-backed `list()` (which is what a
`filter` on non-key fields compiles to) caps how many items get **scanned** per page, not
how many **survive the filter** — once the report/gear tables held rows from two full
ingested raids, a single encounter's ~25 rows could easily sit outside whatever 100 items
happened to get scanned first. `ReportsList.tsx`'s own `Report.list()` (no filter, a plain
Scan) already looped `nextToken` correctly and never showed this; every filtered `list()`
call in `ReportDetail.tsx` didn't, and read only the first page. Fixed with a shared
`src/listAll.ts` helper — loops `nextToken` to `null` before returning — now used by every
`list()` call in the app (`ReportsList.tsx`'s `Report.list()` was refactored onto the same
helper for consistency, though it wasn't broken). Verified against the real deployed API:
`GearListing`/`GearIssue`/`ConsumableScore`/`ShadowResistanceResult` all correctly return
25 rows and `DrumStat` returns 3, matching known-good data (Darthro's exact 4 gear issues)
verified earlier in this project.

## Local development

```bash
npm install
npm run sandbox   # deploys/updates the Amplify backend to AWS (needs AWS_PROFILE=theLWord)
npm run dev        # starts the Vite frontend
```

Deploying the backend requires AWS credentials under a profile (this project uses
`theLWord`) and, for a brand-new AWS account/region, a one-time CDK bootstrap:

```bash
npx aws-cdk bootstrap aws://<account-id>/<region> --profile theLWord
```

**Never pass `--identifier` to `ampx sandbox` for this project.** Always use
`npm run sandbox` (plain `ampx sandbox`, no flags) exactly as written above. The sandbox's
CloudFormation stack name embeds a hash of `namespace + identifier`, where `identifier`
defaults to the OS username if `--identifier` isn't given — for this project that's always
been the unsanitized OS username (e.g. `first-last`, with the hyphen). Passing `--identifier
firstlast` (no hyphen) hashes to a *completely different*, brand-new stack rather than
updating the real one, even though both display the same sanitized name in the stack list
— found the hard way mid-deploy, after it had already fully stood up an empty duplicate
Cognito pool, DynamoDB tables, and Lambdas alongside the real environment. If you ever see
`CREATE_IN_PROGRESS | AWS::CloudFormation::Stack` in the deploy log instead of
`UPDATE_IN_PROGRESS`, stop immediately — that's this happening again.

**Adding a new reference table a function reads in the same change is a chicken-and-egg
problem.** `$amplify/env/<function-name>` (generated at `.amplify/generated/env/*.ts`) only
ever lists `TABLE_NAME_*` entries the local type generator already knew about — confirmed
this does **not** self-heal after a normal successful deploy, unlike what you'd expect. Add a
table to `backend.ts`'s `readOnlyTables` and reference its new `env.TABLE_NAME_X` in the same
commit, and every deploy attempt fails the pre-deploy type-check (`Property 'TABLE_NAME_X'
does not exist...`) before it ever runs — the successful deploy that would regenerate the
type is the one thing type-check is blocking. Workaround: read that one variable via a cast
(`(env as unknown as Record<string, string>).TABLE_NAME_X`) instead of the typed accessor;
it's not just a one-deploy bootstrap step, keep the cast permanently (see `gearIssues.ts`'s
`gemQualities` load in `handler.ts` for the pattern and a fuller comment).

**The sandbox watcher's own file-lock cleanup is flaky, independent of the above.** A
long-running `ampx sandbox` process can leave a stale `.amplify/artifacts/cdk.out/read.<pid>.lock`
behind after a synth pass, then falsely report `MultipleSandboxInstancesError: Other CLIs
(PID=<its own pid>) are currently reading from cdk.out` on its very next trigger — reproduced
several times in a row, always self-referential (the "other" PID is the same process). Fix:
kill it, `rm -f .amplify/artifacts/cdk.out/read.*.lock`, and start a fresh `npm run sandbox`.

## Secrets

Three Warcraft Logs secrets, stored as Amplify secrets and never in a file in this repo. All three
are read by `wcl-client` only:

| Secret | Used for |
|---|---|
| `wclApiKey` | WCL **v1** REST API key (report data) |
| `wclClientId`, `wclClientSecret` | WCL **v2** OAuth client credentials (parse rankings, crit records). Create a client at `https://classic.warcraftlogs.com/api/clients` — a normal confidential client, "Public Client" unchecked, any redirect URL |

```bash
# sandbox — prompts for the value, nothing is echoed
npx ampx sandbox secret set wclApiKey --profile theLWord
npx ampx sandbox secret set wclClientId --profile theLWord
npx ampx sandbox secret set wclClientSecret --profile theLWord
npx ampx sandbox secret list --profile theLWord             # lists names only, no values
```

**Production** secrets are set in the Amplify console (app -> Hosting -> Secrets), where they are
stored in SSM Parameter Store under `/amplify/shared/<appId>/<name>` (sandbox:
`/amplify/<namespace>/<identifier>/<name>`). **A deploy fails if any declared secret is missing in
its environment**, so set a new secret in production *before* pushing code that declares it.

AWS credentials for the `theLWord` profile live in `~/.aws/credentials` on the
developer's machine (via `aws configure --profile theLWord`), never in this repo.

## Admin access

`/admin` (report ingest) is the only screen behind a login — everything else is public. Admin
accounts are invite-only: there's no self-service signup, matching the "protected ingest screen,
public everything else" requirement. To add an admin:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <user_pool_id from amplify_outputs.json> \
  --username <their email> \
  --user-attributes Name=email,Value=<their email> Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --profile theLWord

aws cognito-idp admin-add-user-to-group \
  --user-pool-id <user_pool_id> \
  --username <their email> \
  --group-name admins \
  --profile theLWord
```

Leaving out `--temporary-password` lets Cognito auto-generate one and email it directly — the
password is never seen or set by whoever runs this command. The recipient signs in with that
temporary password and Cognito's own "new password required" flow (handled automatically by the
`Authenticator` component `/admin` uses) makes them set a real one before continuing.

The frontend uses `@aws-amplify/ui-react`'s `<Authenticator hideSignUp>` for the sign-in form
itself — signing in only proves an account exists (all of which are admin-created), but the
`ingestReport` mutation is what actually enforces `admins` group membership server-side; the
frontend's own group check (via `fetchAuthSession()`) just gives a clearer message than a raw
GraphQL authorization error in the case where those two ever diverge.

**Dev-session gotcha: stale cached guest credentials.** The browser caches its
unauthenticated Cognito Identity Pool credentials (via `aws-amplify`'s own
localStorage-backed credential cache) across page loads. After a backend redeploy — new
IAM policy, new table grant, changed auth rules — a tab left open from before the deploy
can keep using the old cached credentials and show a misleading `Unauthorized` error even
though the deployed policy is actually correct. If public reads suddenly 401 right after a
deploy, `localStorage.clear(); sessionStorage.clear();` and reload before assuming it's a
real permissions bug.

## Warcraft Logs integration

`amplify/functions/wcl-client` is the only thing in the backend that knows Warcraft Logs' API
shapes. It is a single action-dispatched Lambda (not one function per endpoint), because the
worker calls many of them together for one report:

| Action | API | Used for |
|---|---|---|
| `getReportFights` | v1 `/report/fights` | Title, zone, date, the fight list and friendlies |
| `getSummaryTable` | v1 `/report/tables/summary` | Per-player gear, talents and deaths for a window |
| `getTable` | v1 `/report/tables/{view}` | `buffs` (per player), `damage-done` (per boss fight) |
| `getEvents` | v1 `/report/events` | Casts and applied buffs, for the drum rule |
| `getFightRankings` | v2 `report.rankings` | Parse percentiles for every kill in a report, in one query |
| `getFightCrits` | v2 `report.events` | Highest critical hit and heal per boss fight |
| `getParses` | v1 `/parses/character` | No longer used by ingest — it returned only part of a character's kills |

**v1 (API key).** The base URL is a per-call parameter (`baseUrl`), defaulting to
`https://classic.warcraftlogs.com/v1`. Confirmed working against the example report the original
spreadsheet's cached data came from (`WL3G9wbYBx14nyqV`, "The L Word SSC 7/3") — title, roster and
gear (down to the exact enchant-missing "Polar Bracers" on Nightfyst) matched exactly. WCL returns
*retail* enchant names for TBC effect ids, which is why `EnchantName` exists.

**v2 (OAuth client credentials).** `wcl-client` fetches a token from `/oauth/token`, caches it for
the life of the warm container and refreshes it once on a 401. v2 is used for exactly two things:
- **Parses** — `rankings` returns every kill's percentile in one query. v1's per-character
  `/parses` endpoint returned only 106 of 216 kills; v2 covers 211 of 211 that have damage data.
- **Crit records** — `events` with the server-side filter `isCritical = true and source.type =
  "Player"` and `useAbilityIDs: false` (ability names inline). One query per damage/heal covers a
  whole raid night, but a night is ~5,000 crit events, so the client **must follow
  `nextPageTimestamp`**; it picks each fight's winner inside the Lambda so responses stay ~2 KB.
  v2's `DamageDone` already excludes friendly fire.

**Rate limits.** v1 starts returning `429` after a burst (a bulk re-ingest tripped it after about 15
reports in four minutes) and then stays blocked for an hour or more. v2 allows 9,000 points an hour
and each of the queries above costs ~1, so it is effectively unlimited for this app. The worker
fetches everything it needs from WCL for a fight *before* deleting that fight's old rows, so a 429
aborts the fight without destroying anything — re-run it later. See `docs/OPERATIONS.md`.

## Ingesting a whole raid

The admin ingest screen originally took a report code *and* a specific fight id — one
mutation call per encounter. Task 11 removed the fight id entirely: give it just a report
code and it ingests every encounter in the raid night.

**Why this needed a fast trigger + a separate worker, not just one bigger Lambda.** A real
raid report can have 50+ WCL fights — a live SSC report used for testing had 51, only 6 of
them bosses. Fully processing one encounter needs roughly (1 summary call + 1 buffs-table
call *per character* + 2 events calls) WCL calls; at ~25 raiders that's on the order of a
thousand-plus WCL calls for one raid night. AppSync kills a Lambda-backed resolver at a
**hard 30 seconds**, regardless of the Lambda's own configured timeout — so the mutation
itself (`ingest-report`) can't do this work synchronously no matter how long its timeout is
set to. It's split in two:

- **`ingest-report`** (the actual mutation handler) — fetches the fight list from WCL (one
  fast call), asynchronously invokes `ingest-report-worker` (fire-and-forget:
  `InvocationType: 'Event'`, which returns as soon as Lambda accepts the invocation, not
  when the worker finishes), and returns `{ title, zone, fightCount }` immediately. Timeout
  25s — comfortably under AppSync's cap with margin.
- **`ingest-report-worker`** — does the real work. Timeout 900s (Lambda's max). Never
  invoked synchronously, so it isn't bound by AppSync's limit at all. New encounters appear
  on the Reports list progressively as it finishes each one, rather than all at once — a
  full raid night can take a minute or two.

**Bounding WCL concurrency.** The worker doesn't process fights and characters serially
(that would risk running long), but it also doesn't fire all ~1,000+ WCL calls at once —
`invokeWclClient` acquires a small in-process semaphore (`WCL_CONCURRENCY_LIMIT = 8`)
before every call, so at most 8 WarcraftLogs requests are ever in flight simultaneously
regardless of how the surrounding `Promise.all` loops are structured. Gentle on WCL's API
without sacrificing much speed — at this volume the whole run still finishes in well under
a minute of WCL latency.

**Grouping WCL's fight list into encounters (`rules/groupEncounters.ts`).** The naive
approach — one row per boss encounter (`fight.boss !== 0`), everything else is trash — is
wrong. **WCL only sets a nonzero `boss` id on the fight that actually lands the kill.** Wipe
attempts on that same boss come back with `boss: 0`, identical to real trash by that field
alone (confirmed live: 3 wipes then a kill on Hydross the Unstable — all four fights shared
the name "Hydross the Unstable", only the 4th had `boss != 0`). The actual algorithm:

1. Group *adjacent* fights sharing the same `name` into a "run" (a boss's wipes + kill, or
   one trash pack's consecutive pulls).
2. A run is a **boss encounter** if any fight in it has `boss != 0` — nothing else. (An
   earlier version also fell back to matching the run's name against
   `RaidValidationRule.bossName`, to catch a boss attempted all night but never downed.
   Deployed it, re-ingested a real Tempest Keep report, and every trash pack the reference
   data tracks a kill-count requirement for — "Crystalcore Sentinel", "Bloodwarder
   Vindicator", "Phoenix-Hawk", etc., all genuine `bossName` rows in `RaidValidationRule`,
   used for trash-volume validation, not discrete encounters — got misfiled as its own boss
   row. Removed the fallback entirely; a boss wiped all night with zero kills anywhere in
   the report just folds into the surrounding trash gap instead, which is a far better
   failure mode than turning common trash into bogus bosses.)
3. Consecutive **trash** runs (even across different pack names) merge into one combined
   row per gap between boss encounters — a synthetic time window from the first trash
   pull's start to the last one's end, reusing the exact same per-fight WCL calls (every
   call here is windowed by `start_time`/`end_time` alone, so a merged window needs no
   special-casing). This cut the 51-fight sample down to 6 trash-gap rows.
4. Boss runs are **not** collapsed — each attempt (wipe or kill) still gets its own `Report`
   row with its own gear/consumables/drums/SR, since gear and strategy can genuinely change
   attempt to attempt. All attempts on the same boss share an `encounterGroupKey` (the
   boss's name) so the frontend can group them under one expandable row (`ReportsList.tsx`)
   instead of listing every wipe as an unrelated encounter.

For that same 51-fight SSC sample: 6 bosses × ~1-4 attempts each (9 individual rows) + 6
trash-gap rows = **15 total `Report` rows**, not 51 — confirmed against two independently
ingested live reports (SSC and a Tempest Keep night), both landing on exactly the expected
counts after the `bossName` fallback was removed.

`validateReport` is unaffected by any of this grouping — it still runs once, directly
against the raw, ungrouped `reportFights.fights`/`enemies` WCL returned, and writes the one
shared `ValidationResult` row for the report code after every encounter's finished
processing.

### Worker modes

`ingest-report-worker` takes `{ reportCode, baseUrl?, ... }`. The optional flags select a cheaper
mode that reuses stored data, which is what makes bulk backfills practical:

| Mode | Event | What it does | WCL cost |
|---|---|---|---|
| Full ingest | `{ reportCode }` | Everything: fights, gear, consumables, drums, damage, deaths, parses, crit records, `RaidNight` | Hundreds of v1 calls per raid night, plus 3 v2 calls |
| Parses only | `+ parsesOnly: true` | Re-pulls parse percentiles from v2 into stored `DamageStat` rows | v2 only |
| Rollup only | `+ raidNightOnly: true` | Rebuilds the `RaidNight` rollup from stored rows | none |
| Crits only | `+ critsOnly: true` | Re-pulls crit records from v2, then rebuilds the rollup | v2 only |

A full ingest is idempotent per fight: it fetches everything for a fight first, then clears and
rewrites that fight's rows, so a failed WCL call leaves the previous rows intact.

## Raid Reports list and pagination

`ReportsList.tsx` loads raids **15 per request** (`PAGE_SIZE`), newest first, with a "Load 15 more"
button. It queries the `RaidNight` summary table through its date index instead of reading every
encounter row — `Report` is keyed `reportCode` + `fightId`, so a scan returns rows in hash order, not
date order, and one raid is 9-25 rows; "the newest 15 raids" is not answerable from it.

- **Collapsed raid headers** (title, zone, date, kills/bosses) render from the `RaidNight` row alone.
- **Encounters load on expand** with a keyed partition query for that `reportCode` (the generated
  types don't expose key arguments on `list()` for this model, so the call is cast). Cached per raid.
- **Zone and search are server-side filters**, so they span every page. DynamoDB applies a filter
  *after* its page limit, so a filtered request can come back short; when filtering, the list fetches
  wider and buffers the surplus, which keeps each click at exactly 15. Changing a filter resets to
  page one and drops stale responses. The zone dropdown is a fixed list of TBC raid zones.
- **Admin delete** updates the open list locally; the delete Lambda recomputes the server-side summary
  and removes the raid when its last boss attempt goes.

## Report detail tabs

`ReportDetail.tsx` shows one encounter. Damage is the first tab and the one a report opens on.

| Tab | Shows |
|---|---|
| Damage | Total damage (every hostile target in the encounter window, adds included), DPS, normalized share of raid damage, and the Warcraft Logs **parse** in WCL's tier colours. Defaults to biggest first; sortable by damage, DPS or parse. Healers show no parse (WCL ranks them on damage against other healers, which is meaningless) and sort as unranked; wipes have no parse |
| Gear Check Summary | One row per raider: Overall, Enchant, Gem, Empty Slot — plus **Shadow Resist, on the Mother Shahraz encounter only** (the Black Temple 164 shadow-resistance check; tanks are exempt). The Overall roll-up uses the same scope, so a hidden check can never fail anyone |
| Gear Issues | Per slot: the item (Wowhead link), the issue (No/Weak Enchant, No/Weak Gem, Empty Slot) and what is currently equipped |
| Deaths | Who died and when, in fight time |
| Consumables | Elixirs, flask, food, weapon enhancement, scroll, potions and healthstones |
| Drums | Drum casts and the buffs each one landed |
| Shadow Resistance | Per-raider gear shadow resistance — **shown for the Mother Shahraz encounter only** |
| Gear Listing | The full equipped set, paper-doll style, with enchants and quality-coloured gems |

The Log Validation tab is not shown. Its data is still ingested (`ValidationResult`) and the code is
still in `ReportDetail.tsx`, so restoring it is a one-line change to `TABS`. Filters (class, spec,
role, and an issue filter on the two gear tabs) and sorting apply across the character tabs.

## Hall of Records

The sidebar's records board. Definitions:

| Record | Definition |
|---|---|
| Most Deaths | Deaths per character, **boss and trash both counted**, since the Phase 3 reset (see "Feature flags"). Ties are shared ("Negachinn & Spìkë"), capped at three names then "& N others". A runner-up and the **Pre Phase 3 Record** are shown beneath it |
| Highest Damage Crit | The single largest critical hit by a player against a hostile target — **all-time, never resets**, **players only** (no pets). Shows the holder, the ability, the **boss it happened on** and the **date** |
| Highest Healing Crit | The single largest critical heal by a player, as **gross** (effective + overheal — the number the healer saw). Same layout; all-time, players only. Abilities that cannot critically strike (Lay on Hands, Healthstones, potions, Judgement of Light, Vampiric Touch/Embrace) are ignored because WCL's `isCritical` matches them anyway (`NON_CRITTING_HEAL` in `wcl-client/handler.ts`) |
| Bosses Slain / Boss Wipes / Minutes in Boss Combat | Boss attempts with a non-zero duration (zero/null-duration rows are WCL glitches and hidden everywhere) |
| Records kept since | The earliest fight ever ingested, trash included |

Ties on a crit record go to whoever set it first.

**How it is computed.** Each `RaidNight` row carries that raid's own contribution: `killAttempts`,
`wipeAttempts`, `bossSeconds`, `firstFightDate`, `deathEvents` (every death as an epoch-second, `null`
when it can't be placed in time — counted as current), `classes` (for name colours), and the raid's
best crits (`topCritDamage` / `topCritHeal`, derived from the per-fight `critByFight`). The sidebar
fetches all `RaidNight` rows in **one request** with a `selectionSet` that skips titles, search text and
`critByFight`, and sums them in the browser (`src/hallOfRecords.ts`). Per-raid rows — rather than one
global row — mean concurrent ingests never race, and a re-ingest or delete fixes only that raid.

**Why.** It used to scan `Report` (658 rows), `DeathRecord` (4,873) and `GearListing` (13,326 rows
of ~2 KB, read only to look up a class colour) on every page load: ~30 MB, **72 AppSync requests and
about 17 seconds** to appear, measured on production. Now it is one request, and repeat visits paint
from cache before any network call. The Hall's reads were also 83% of the app's DynamoDB read
consumption, so this lowers the AWS bill; the new work happens per ingest, never per page view.

**Cache.** The rows (not the computed numbers) are kept in `localStorage` (`lw:hall:v1`, 7-day
maximum age) and painted immediately while a fresh copy loads; the numbers are recomputed at paint
time so the Phase 3 reset is always judged against the current clock. Bump the key's version whenever
`HallRow` changes shape. On a first-ever visit a skeleton of the same height (`min-height: 440px`)
holds the layout so nothing jumps.

**Keeping it correct.** `recomputeRaidNight` runs at the end of every ingest and after every delete.
Everything except the crit records is derived from that report's own rows, so it can be rebuilt at any
time (`raidNightOnly`). Crit records come from WCL and cannot be rebuilt from DynamoDB, so the helper
**carries `critByFight` forward** from the existing row, overlays fresh results, and prunes fights that
no longer exist — deleting the attempt that held a crit lowers the raid's record to the next best. The
crit lookup is best-effort: if v2 fails, the ingest still succeeds and the previous records stay.

**Growth.** A row is ~1.5-7 KB, so the payload grows ~1.5-7 KB per raid. Fine to a few hundred raids;
past ~300 (or ~1 MB) switch to a single pre-aggregated `GuildStats` row.

## Feature flags

`src/featureFlags.ts` holds compile-time constants (changing one is a redeploy). Currently one:
`MOST_DEATHS_RESET` — `enabled`, `at` (an exact UTC instant; Phase 3 began 2026-08-27 22:00 UTC =
15:00 PDT = 23:00 BST), `label`/`shortLabel`/`labelDate` for the UI. Deaths before `at` stop counting
toward the live Most Deaths standing and are kept as the Pre Phase 3 Record. It is evaluated in the
browser against the viewer's clock, and a raid that straddles the boundary splits correctly because
each death carries its own absolute time. Only Most Deaths resets — the crit records and the boss
counters never do.

## Writing directly to DynamoDB (bypassing AppSync)

`ingestReport` and the seed scripts both write straight to DynamoDB instead of going
through the GraphQL API (this installed Amplify Data version strips `.resource()` out of
the model-level `allow` builder — confirmed by inspecting `ModelType.mjs` directly — so
function-to-model grants have to be plain IAM, wired in `backend.ts` via
`tables[name].grantReadWriteData(...)`). That shortcut has two non-obvious costs, both
found the hard way while getting `ingestReport` working and worth remembering for the
`ConsumableScore`/`ShadowResistanceResult` writes in task 7:

1. **`createdAt`/`updatedAt` are non-nullable on every model.** AppSync normally sets
   these itself; a direct write has to set them explicitly (`new Date().toISOString()`
   for both) or every *read* through AppSync fails schema validation for the whole
   response — not just that field — and the client silently gets `data: null`.
2. **`a.json()` (AWSJSON) fields must be stored as the native DynamoDB structure**
   (a real List/Map from a plain JS object/array), **not** a pre-stringified JSON string.
   AppSync's own resolver does exactly one JSON-encoding pass over whatever's stored to
   build the wire response; pre-stringifying doubles that up. The frontend still has to
   call `JSON.parse()` once on these fields itself — the client does not auto-parse them.
3. **Never write `undefined`.** The delete Lambda's DocumentClient does not strip undefined values
   (the worker's does, via `removeUndefinedValues`), and an undefined attribute makes the whole write
   fail. Omit optional attributes with a conditional spread instead (see `raidNight.ts`).

**Custom mutation names collide with Amplify's auto-generated CRUD mutations.** The
cascading-delete Lambda (task 9) is exposed as a custom mutation, and it was originally
named `deleteReport` to match the Lambda/folder name — but Amplify Data already
auto-generates a `deleteReport` mutation for the `Report` model itself (plain single-row
delete, no cascade). The two silently shadowed each other at the schema level. Renamed the
custom one to `deleteReportCascade` in `amplify/data/resource.ts` to disambiguate; the
frontend (`ReportsList.tsx`) calls `dataClient.mutations.deleteReportCascade(...)`. Worth
remembering for any future custom mutation whose name might match a model's default CRUD
verb (`create<Model>`, `update<Model>`, `delete<Model>`, `list<Model>`, `get<Model>`).

## Log validation (`validate.ts`)

Checks whether a report has enough kills of the required bosses/trash groups to count as
a legitimate clear, using two things confirmed against a live report rather than assumed
from docs:

- **`enemies[].guid`** in WCL's `getReportFights` response is the enemy's real NPC
  template ID — it matches `RaidValidationRule.npcIds` directly (confirmed: guid `21217`
  = "The Lurker Below", the exact npcId decoded from the reference workbook's "SSC start
  point"). Each enemy's `fights[].instances` is how many copies of it appeared in a given
  fight; summing that across the right fights gives a real kill count.
- **`kill: true/false` is only ever populated on fights with a nonzero `boss`** (a
  designated encounter). Every trash-type fight (`boss: 0`) has `kill: undefined` — there
  is no wipe/kill distinction tracked for trash the way there is for bosses. Filtering all
  fights on `kill === true` silently zeroes out every trash-volume requirement; trash
  fights have to count unconditionally, with only boss encounters needing the explicit flag.
  (The same underlying fact — wipe attempts on a boss are indistinguishable from trash by
  `boss` alone — is also why `groupEncounters.ts` groups by adjacent fight *name*, not the
  `boss` flag; see "Ingesting a whole raid" above.)

Not reimplemented: the original tool's zone-combination nuances (manual zone override,
trash-only/boss-only toggles, "valid starting point" check). This validates every rule for
every known zone that appears anywhere in the report's fights — correct for the common
case of one instance per report, not a full port of the dropdown-driven UI's edge cases.

## Gear issues (`gearIssues.ts`)

Flags gear missing a permanent enchant (or with a known-suboptimal one) and gear with an
unfilled gem socket. One case needed real live-data validation, not just the reference
tables: **OffHand (slot 16) is ambiguous in a way no other enchantable slot is.** It can
hold a real one-hand weapon or shield (enchantable) *or* a "Held In Off-Hand" caster/healer
stat-stick — an orb, tome, totem, libram, etc. — which cannot be enchanted at all in TBC.
WCL's v1 API gives gear items only `{id, slot, quality, icon, itemLevel}`, no item-type/
subclass field, so this checks the `icon` filename against Blizzard's own weapon/shield
icon-naming convention (`inv_sword_`, `inv_axe_`, `inv_mace_`, `inv_dagger_`, `inv_fist_`,
`inv_gauntlets_`, `inv_weapon_`, `inv_shield_`) instead of relying on slot number alone.
Validated against 16 real offhand items pulled live from this project's own test report —
every shield and dual-wieldable weapon matched correctly, and every actual holdable
("Windcaller's Orb", "Talisman of the Sun King", "Tears of Heaven" — a healer stat-stick
styled as a vial, icon `inv_potion_75` — "Jewel of Infinite Possibilities") correctly did
not get flagged. `inv_fist_`/`inv_gauntlets_` are included on Blizzard's general
icon-naming convention, not independently confirmed against a live fist-weapon offhand — no
example turned up in the test data.

Considered the official Blizzard Game Data API instead (it returns a real
`inventory_type`/`item_subclass` per item — no edge cases at all), but that needs a
Blizzard Developer account + OAuth client credentials, a new Lambda for the token exchange
and lookups, a new reference table to cache results, and confirming which namespace
actually serves TBC Classic item data before trusting it — meaningfully more setup for a
case the icon heuristic already handles correctly. Left as a possible future hardening
pass, not built.

**Structured output, not display strings.** `analyzeGear()` returns `GearIssueEntry[]`
(`{slot, itemId, itemName?, issueType, currentValue?}`), not pre-joined strings — the
frontend renders slot name, a WowHead link (`https://www.wowhead.com/tbc/item=<itemId>`),
and a color-coded badge per `issueType` (`emptySlot` | `noEnchant` | `noGem` | `weakEnchant`
| `weakGem`). For `weakEnchant`/`weakGem`, `currentValue` carries the suboptimal
enchant's label (from `SuboptimalEnchant`) or the equipped gem's quality tier name.

**Weak gem detection (`GemQuality` table).** The min-gem-quality check was originally a
deliberate gap — WCL's gem data (`{id, itemLevel, icon}`) has no rarity, and `itemLevel`
comes back as a flat, meaningless `70` for every classic gem. `id` *is* a real, stable WoW
item ID though, and TBC's gem set is small and fixed (~240 items), so this is now backed by
a standalone `GemQuality` reference table (`itemId -> 'Common'|'Uncommon'|'Rare'|'Epic'`,
same `publicReadAdminWrite` pattern as the other reference tables). A gem is flagged
`weakGem` when its tier is below Rare.

Sourcing that table: scraping Wowhead's own listing pages directly doesn't work (a plain
request gets HTTP 403 from Wowhead's CloudFront edge, and the modern listing UI hydrates via
client-side JS, not an inline payload). Instead, `scripts/seed/scrape_gem_qualities.py` pulls
from the open-source **wowsims/tbc** project (MIT-licensed), which republishes Wowhead's own
per-item tooltip JSON as two flat CSVs on `raw.githubusercontent.com` (no bot-protection):
`all_gem_ids.csv` (every known gem item ID) and `all_item_tooltips.csv` (id -> tooltip JSON
with quality). Two fetches, not one per gem. Gotcha: the tooltip JSON embeds `\"`-escaped
quotes, which is invalid RFC4180 CSV quoting — a plain `csv.reader` mis-parses almost every
row. The script regex-matches the `id`/`name`/`quality` prefix directly out of the raw text
instead. Re-run and reload (`node scripts/seed/load_to_dynamodb.mjs --model GemQuality
--file scripts/seed/data/gem-qualities.json`) if TBC ever gets new gems.

## Item and character links (`src/links.tsx`)

Two small shared components, used everywhere an item or character name renders:
- `WowheadItemLink` — `{itemId, itemName}` -> a link to `https://www.wowhead.com/tbc/item=<itemId>`.
- `ArmoryLink` — `{characterName}` -> a link to
  `https://classic-armory.org/character/us/tbc-anniversary/dreamscythe/<characterName>`
  (`dreamscythe` is a fixed realm segment, not configurable).

Both render as plain text with a small low-opacity arrow glyph suffix (Nucleo's
`ni-curved-next`, already vendored) rather than a heavier "external link" treatment — styled
in `src/assets/css/sanctum.css` (`.armory-link`, `.wowhead-link`). `ReportDetail.tsx` is the only file that
ever renders a character name (confirmed via `grep -rln characterName src` — `ReportsList.tsx`
has none), so `ArmoryLink` is wired into all five of its tabs' `<th scope="row">` cells.

## Consumables, drums, and shadow resistance

Three more rule modules, each with a different data-reliability story — worth knowing before
trusting or extending any of them:

**`consumables.ts` (high confidence).** Battle/guardian elixir, flask, food, and scroll spell
IDs come straight from the reference workbook's `buffConsumables` tab (seeded into
`ConsumableBuff`). Presence is checked per player via WCL's `buffs` *table* view filtered with
`targetid` — not raw events — because elixirs/flasks/food are almost always applied before the
pull; a live check found zero `applybuff` events for a flask known (from the aggregate table) to
be active for the whole fight, confirming the buff predated the report's own recorded window.
Weapon enhancement doesn't need a WCL call at all: gear already carries `temporaryEnchant`/
`temporaryEnchantName` directly (confirmed live — several casters showed "Superior Wizard Oil").
Not reimplemented: the original's per-class denominator adjustment and JC-neck usage counter.

**`shadowResistance.ts` (high confidence for gear, medium for the buff bonus).** SR from gear
reuses the same gear array GearListing already has, against the already-seeded
`ShadowResistanceItem` table — no extra calls. SR from buffs is a flat bonus for "Prayer of
Shadow Protection" (guid `39374`, found by searching a live report's buff list for
"shadow"/"protection" rather than guessed), using +70 SR — the exact value observed in the one
real example row decoded from the original workbook, not a generic spell-database number. No WoW
race has an innate Shadow Resistance bonus, so the original column's "and race" appears to be
vestigial.

**`drums.ts` (high confidence for the mechanism, medium for full drum-type coverage).** Cast
events and the `applybuff` events they produce share the same ability guid (confirmed: "Drums of
Battle", guid `35476`), and unlike consumables, drum casts happen *during* the fight, so raw
events in the fight window are enough — no per-player WCL calls needed. One real timing quirk
had to be fixed after a live test: some `applybuff` timestamps land 1-2ms *before* the cast that
triggered them (simultaneous events aren't guaranteed to log in cast-then-effect order), so the
cast→buff attribution window is generous in both directions, not just forward. Only "Drums of
Battle" was actually observed in a live report; "Drums of War" (`35475`) and "Drums of
Restoration" (`35478`) are included on the strength of Blizzard's usual sequential-ID pattern for
an item family, not independently confirmed — check here first if a report's drum stats look off.

## Re-seeding reference data

If the source spreadsheets change:

```bash
python3 scripts/seed/extract_reference_data.py "<path to CLA workbook>.xlsx"
python3 scripts/seed/extract_external_reference_data.py "<path to reference workbook>.xlsx"

AWS_PROFILE=theLWord node scripts/seed/load_to_dynamodb.mjs --model ItemSocket --file scripts/seed/data/item-sockets.json
AWS_PROFILE=theLWord node scripts/seed/load_to_dynamodb.mjs --model ShadowResistanceItem --file scripts/seed/data/shadow-resistance-items.json
AWS_PROFILE=theLWord node scripts/seed/load_to_dynamodb.mjs --model SuboptimalEnchant --file scripts/seed/data/suboptimal-enchants.json
AWS_PROFILE=theLWord node scripts/seed/load_to_dynamodb.mjs --model ExcludedGearItem --file scripts/seed/data/excluded-gear-items.json
AWS_PROFILE=theLWord node scripts/seed/load_to_dynamodb.mjs --model RaidValidationRule --file scripts/seed/data/raid-validation-rules.json
AWS_PROFILE=theLWord node scripts/seed/load_to_dynamodb.mjs --model ConsumableBuff --file scripts/seed/data/consumable-buffs.json
```

Each script prints a warning if it finds conflicting values for the same key (this has
happened — the source data isn't perfectly clean) instead of silently picking one.

## Tearing down AWS resources (stop billing)

Everything deployed so far is a **sandbox** environment — cheap (DynamoDB/Lambda/AppSync
are pay-per-use with no idle cost; Cognito is free at this scale) but not zero, and it's
real infrastructure sitting in your account until deleted. To remove it all:

```bash
cd path/to/the-l-word
npx ampx sandbox delete --profile theLWord
```

This deletes the entire CloudFormation stack for this project: Cognito user pool,
AppSync API, every DynamoDB table (all seeded data goes with it), and any Lambda
functions. It prompts for confirmation before deleting anything.

**What that command does *not* remove:**

1. **The CDK bootstrap stack** (`CDKToolkit`) — a one-time, account/region-wide staging
   bucket + IAM roles that CDK/Amplify needs for *any* deploy, not specific to this
   project. Harmless to leave (an empty/near-empty S3 bucket), but if you want it gone
   too and don't plan to deploy anything else CDK-based to this account:
   ```bash
   aws cloudformation delete-stack --stack-name CDKToolkit --profile theLWord --region us-east-1
   ```
2. **The IAM user and access key** (`lword_admin`) — not billed, but if you want to fully
   revoke this machine's access to your AWS account, deactivate or delete the access key
   (IAM Console → Users → `lword_admin` → Security credentials), or delete the user
   entirely if it's not used for anything else.
3. **Your AWS account itself** obviously isn't touched by any of the above.

If you just want to *pause* rather than fully tear down, `ampx sandbox delete` is still
the right move — re-running `npm run sandbox` later recreates everything from
`amplify/` (the schema in this repo), though you'd need to re-run the seed-loading step
above since deleting the tables deletes their data too.

## License and credits

The project's own code is released under the [MIT License](LICENSE). Third-party assets keep their
own licenses; the full list is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). In particular:

- **Icons — Nucleo.** The UI's icon font (`src/assets/plugins/nucleo/`) is from **Nucleo**
  ([nucleoapp.com](https://nucleoapp.com)), designed and owned by its authors, and is used under the
  [Nucleo license](https://nucleoapp.com/license/). It reached this project through **Creative Tim's
  Argon Dashboard** template. The Nucleo files are **not** covered by this repository's MIT license.
- **Game data — wowsims/tbc** (MIT) republishes Wowhead's item data used to seed the reference tables;
  item names and tooltips remain the property of **Wowhead** and **Blizzard Entertainment**.
- **Combat logs — Warcraft Logs**, **character links and avatars — Classic Armory**, **typeface —
  Cinzel** (SIL Open Font License, via Google Fonts).
- *World of Warcraft* is a trademark of Blizzard Entertainment. This is an unofficial fan project, not
  affiliated with or endorsed by Blizzard, Warcraft Logs, Wowhead, Nucleo or Creative Tim.
