import { defineFunction } from '@aws-amplify/backend';

/**
 * Fast trigger for a raid-wide ingest: fetches the fight list from
 * WarcraftLogs, fires the actual per-fight work at ingest-report-worker
 * asynchronously, and returns immediately. Deliberately does *not* touch
 * DynamoDB or run any rule modules itself — this is the mutation's
 * synchronous resolver, and AppSync kills a Lambda-backed resolver at 30s
 * regardless of the function's own configured timeout, so it has to stay
 * fast no matter how big the report is. See ingest-report-worker for the
 * part that actually takes a while.
 *
 * All env values below are placeholders — the real function names aren't
 * known until synth, so backend.ts overrides them via `addEnvironment`
 * once the other resources exist. They're declared here so the generated
 * `$amplify/env/ingest-report` types include the keys.
 */
export const ingestReport = defineFunction({
  name: 'ingest-report',
  entry: './handler.ts',
  timeoutSeconds: 25,
  // This function is the custom mutation's handler AND (transitively,
  // via wcl-client invoke) a resource the data stack depends on — keeping
  // it alongside ingest-report-worker in the data stack avoids the same
  // circular-dependency issue that resourceGroupName avoids for the worker.
  resourceGroupName: 'data',
  environment: {
    WCL_CLIENT_FUNCTION_NAME: '',
    WCL_DEFAULT_BASE_URL: 'https://classic.warcraftlogs.com/v1',
    INGEST_WORKER_FUNCTION_NAME: '',
  },
});
