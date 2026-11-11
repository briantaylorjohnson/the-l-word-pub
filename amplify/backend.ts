import { defineBackend } from '@aws-amplify/backend';
import { Tags } from 'aws-cdk-lib';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { wclClient } from './functions/wcl-client/resource';
import { ingestReport } from './functions/ingest-report/resource';
import { ingestReportWorker } from './functions/ingest-report-worker/resource';
import { deleteReport } from './functions/delete-report/resource';

const backend = defineBackend({
  auth,
  data,
  wclClient,
  ingestReport,
  ingestReportWorker,
  deleteReport,
});

// `.resources.lambda` is typed as the CDK IFunction interface, but
// Amplify-defined functions are always the concrete construct, which is
// what actually has addEnvironment.
const wclClientLambda = backend.wclClient.resources.lambda as LambdaFunction;
const ingestReportLambda = backend.ingestReport.resources.lambda as LambdaFunction;
const ingestReportWorkerLambda = backend.ingestReportWorker.resources.lambda as LambdaFunction;

// ingestReport (trigger) only needs enough to fetch the fight list and
// hand off to the worker — it never touches DynamoDB itself.
wclClientLambda.grantInvoke(ingestReportLambda);
ingestReportLambda.addEnvironment('WCL_CLIENT_FUNCTION_NAME', wclClientLambda.functionName);
ingestReportWorkerLambda.grantInvoke(ingestReportLambda);
ingestReportLambda.addEnvironment('INGEST_WORKER_FUNCTION_NAME', ingestReportWorkerLambda.functionName);

// ingestReportWorker does the actual work: calls wcl-client itself (many
// times, per fight/per character) and reads reference tables / writes
// report tables directly via DynamoDB (not through AppSync) — this
// installed Amplify Data version doesn't support `allow.resource()` at the
// model level, so IAM grants + table-name env vars are the supported way
// to give a function direct table access.
wclClientLambda.grantInvoke(ingestReportWorkerLambda);
ingestReportWorkerLambda.addEnvironment('WCL_CLIENT_FUNCTION_NAME', wclClientLambda.functionName);

const tables = backend.data.resources.tables;
const readOnlyTables = [
  'ItemSocket',
  'SuboptimalEnchant',
  'ExcludedGearItem',
  'RaidValidationRule',
  'ConsumableBuff',
  'ShadowResistanceItem',
  'ShadowResistanceEnchant',
  'CharacterRace',
  'GemQuality',
] as const;
const readWriteTables = [
  'Report',
  'GearListing',
  'GearIssue',
  'ValidationResult',
  'ConsumableScore',
  'DrumStat',
  'ShadowResistanceResult',
  'DeathRecord',
  'DamageStat',
  'RaidNight',
  'IngestStatus',
  // Read-mostly, but the worker also learns names WCL supplies for items
  // missing from the seeded set (Anniversary-realm seasonal gear that no
  // public TBC dataset carries), so it needs write access too.
  'ItemName',
] as const;

for (const name of readOnlyTables) {
  tables[name].grantReadData(ingestReportWorkerLambda);
  ingestReportWorkerLambda.addEnvironment(`TABLE_NAME_${name.toUpperCase()}`, tables[name].tableName);
}
for (const name of readWriteTables) {
  tables[name].grantReadWriteData(ingestReportWorkerLambda);
  ingestReportWorkerLambda.addEnvironment(`TABLE_NAME_${name.toUpperCase()}`, tables[name].tableName);
}

// deleteReport needs delete (+ query, to find child rows) on Report and
// every table ingestReportWorker writes — the same readWriteTables list
// minus the reference tables, which nothing ever deletes from at request
// time.
const deleteReportLambda = backend.deleteReport.resources.lambda as LambdaFunction;
for (const name of readWriteTables) {
  tables[name].grantReadWriteData(deleteReportLambda);
  deleteReportLambda.addEnvironment(`TABLE_NAME_${name.toUpperCase()}`, tables[name].tableName);
}

// Cost allocation. Amplify tags prod resources with amplify:app-id, but
// sandbox resources carry no app-level tag at all, so Cost Explorer can't
// tie dev spend to this app. A tag on the root stack propagates to every
// taggable resource beneath it (tables, functions, API, user pool) in both
// environments; amplify:deployment-type (already present) then splits
// prod from dev within it.
Tags.of(backend.stack).add('app', 'the-l-word');
