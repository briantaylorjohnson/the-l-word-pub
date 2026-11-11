# Operations

Runbook for deploying, backfilling and troubleshooting. Commands assume the `theLWord` AWS profile and
region `us-east-1`. The production Amplify app id is your Amplify app's id, shown below as `<APP_ID>` (branch `main`); the sandbox is a
separate stack deployed with `npm run sandbox`.

```bash
export AWS_PROFILE=theLWord AWS_REGION=us-east-1
```

## Deploying

**Production deploys by pushing to `main`.** Amplify Hosting runs `npx ampx pipeline-deploy` for the
backend and then builds the frontend (`amplify.yml`); a push that changes the backend has taken about 6
minutes and a frontend-only push 4-5 (observed on recent jobs).

```bash
git push origin main
# then watch the job (replace <JOB_ID> with the id printed by list-jobs)
aws amplify list-jobs --app-id <APP_ID> --branch-name main --max-results 1 \
  --query "jobSummaries[0].[jobId,status,commitId]" --output text
aws amplify get-job --app-id <APP_ID> --branch-name main --job-id <JOB_ID> \
  --query "job.summary.status" --output text
```

### Order for a change that adds backend data a screen depends on
Ship it **backend first**, then data, then UI — otherwise the new screen briefly shows nothing:

1. **Push 1 — backend only** (model fields, helpers, Lambda changes). The old UI keeps working.
2. **Backfill** the new data (see below). Verify it against an independent computation.
3. **Push 2 — the UI** (and docs).

Set any **new secret in production first**: a deploy fails if a declared secret is missing there
(README -> "Secrets").

### Sandbox
`npm run sandbox` deploys and then watches for file changes. Never pass `--identifier` (the README
explains the duplicate-stack trap). If it reports `MultipleSandboxInstancesError` naming its *own* PID,
that is the flaky lock — kill it, remove the lock, restart:

```bash
pkill -f "ampx sandbox"; rm -f .amplify/artifacts/cdk.out/read.*.lock; npm run sandbox
```
This happens most often when two edits overlap during a hot redeploy.

## Backfilling data

All three modes invoke the worker Lambda with a JSON payload. Find the function name per environment:

```bash
aws lambda list-functions --query "Functions[?contains(FunctionName,'ingestreportworker')].FunctionName" --output text
```

| Goal | Payload | WCL cost |
|---|---|---|
| Rebuild the Raid list / Hall of Records rollup | `{"reportCode":"<code>","raidNightOnly":true}` | none |
| Refresh the Hall's crit records | `{"reportCode":"<code>","critsOnly":true}` | v2 only |
| Refresh parse percentiles | `{"reportCode":"<code>","parsesOnly":true}` | v2 only |
| Re-ingest a report from scratch | `{"reportCode":"<code>"}` | hundreds of v1 calls |

```bash
aws lambda invoke --function-name <worker> --cli-read-timeout 300 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"reportCode":"<code>","raidNightOnly":true}' out.json && cat out.json
```

To run every report, list the codes from the `Report` table (`reportCode` is the hash key; take the
distinct values) and loop. **Write the list with a trailing newline** — a missing one once joined the
last two codes into a single malformed id and silently skipped two reports. Always check the output of
each invocation (`encountersFailed` for a full ingest; an `errorMessage` key means it failed).

### Verifying a backfill
Compute the same figure two ways and require an exact match: sum the `RaidNight` rollup fields, and
recompute from the raw `Report` / `DeathRecord` / `GearListing` rows. For crits, brute-force the maximum
from raw v1 events for one raid and compare. Do this at verification time — the data changes weekly, so
yesterday's numbers are not a fixed target.

## Rate limits

- **WCL v1** answers `429 Too Many Requests` after a burst (a bulk re-ingest tripped it after ~15 reports
  in about four minutes) and then stays blocked for an hour or more. Retrying every few minutes does not
  help and may prolong it. A full ingest needs hundreds of v1 calls per raid night, so re-ingest a few
  reports at a time, and prefer the v2-only modes (`parsesOnly`, `critsOnly`) and `raidNightOnly`, which
  cost no v1 calls.
- **WCL v2** allows 9,000 points an hour and each query here costs about 1 — effectively unlimited.
- **Safe to retry.** The worker fetches everything for a fight from WCL *before* it deletes that fight's
  old rows, so a `429` aborts the fight without destroying data. Re-run the report later.
- To check v2 usage, query `rateLimitData { pointsSpentThisHour limitPerHour pointsResetIn }`.

## Cost

Billing is pay-per-request (DynamoDB on-demand, AppSync, Lambda), so cost follows usage. For
reference, the app's tagged spend (`app=the-l-word` in Cost Explorer) was about **$0.24 a month**
before the Hall of Records rebuild (AppSync $0.15, DynamoDB $0.09, Lambda inside the free tier).
Check it with:

```bash
aws ce get-cost-and-usage --time-period Start=<yyyy-mm-dd>,End=<yyyy-mm-dd> --granularity MONTHLY \
  --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Tags":{"Key":"app","Values":["the-l-word"]}}'
```
and DynamoDB read consumption per table with CloudWatch (`AWS/DynamoDB`
`ConsumedReadCapacityUnits`, daily `Sum`, table dimension `TableName`).

Before the rebuild, the sidebar's whole-table scans were 83% of all DynamoDB read consumption (about
556k of 673k read units in 30 days). New per-ingest work (the rollup recompute, the v2 crit calls) costs
well under a cent a month. Any future feature that reads whole tables on **page view** is the thing to
avoid; per-ingest work is cheap.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A read returns `data: null` for a whole response | A directly-written row is missing `createdAt`/`updatedAt` (non-nullable). Write both by hand |
| `Unauthorized` right after a deploy | The browser cached old guest credentials. `localStorage.clear(); sessionStorage.clear();` and reload |
| Deploy fails: `Property 'TABLE_NAME_X' does not exist` | Amplify's generated env types lag new tables. Read it via `(env as unknown as Record<string,string>).TABLE_NAME_X` |
| Deploy fails on a missing secret | Set the secret in the Amplify console (production) or with `ampx sandbox secret set` first |
| The sandbox deploy log shows `CREATE_IN_PROGRESS` for a whole new stack | You passed `--identifier`; stop immediately (README -> "Local development") |
| A fight is missing rows after a bulk run | It hit a v1 `429` mid-report; check `IngestStatus` for the report and re-run it later |
| Hall of Records shows `—` for crits | The report's crit records have not been backfilled: run `critsOnly` |
| Sidebar shows old numbers on a repeat visit | It paints from its `localStorage` cache and refreshes in the background; a second refresh shows the new data |

## Teardown
See the README's "Tearing down AWS resources (stop billing)".
