import { defineFunction } from '@aws-amplify/backend';

/**
 * Does the actual per-fight work for a raid-wide ingest: loops every fight
 * in the report (bosses and trash), runs the gear/consumables/drums/SR
 * rules for each, and writes one shared ValidationResult for the whole
 * report. Invoked asynchronously (fire-and-forget) by ingest-report's
 * handler — never called synchronously, so its timeout isn't bound by
 * AppSync's 30s Lambda-resolver cap the way ingest-report's is.
 *
 * A live 51-fight report with ~25 characters needs on the order of 1,400
 * WarcraftLogs calls to fully process (1 report-fights + per-fight: 1
 * summary + 1 buffs-table call per character + 2 events calls). The
 * handler bounds WCL concurrency itself (see WCL_CONCURRENCY_LIMIT), so
 * even at that volume this comfortably fits well inside Lambda's 900s max.
 *
 * Table-name env values are placeholders — backend.ts fills in the real
 * ones (unknown until synth) via `addEnvironment`.
 */
export const ingestReportWorker = defineFunction({
  name: 'ingest-report-worker',
  entry: './handler.ts',
  timeoutSeconds: 900,
  memoryMB: 1024,
  // Same reasoning as ingest-report: a function that's also the grantee of
  // direct table access creates a circular dependency between the default
  // "function" stack and the "data" stack unless it lives in the data
  // stack instead.
  resourceGroupName: 'data',
  environment: {
    WCL_CLIENT_FUNCTION_NAME: '',
    WCL_DEFAULT_BASE_URL: 'https://classic.warcraftlogs.com/v1',
    TABLE_NAME_ITEMSOCKET: '',
    TABLE_NAME_SUBOPTIMALENCHANT: '',
    TABLE_NAME_EXCLUDEDGEARITEM: '',
    TABLE_NAME_RAIDVALIDATIONRULE: '',
    TABLE_NAME_CONSUMABLEBUFF: '',
    TABLE_NAME_SHADOWRESISTANCEITEM: '',
    TABLE_NAME_REPORT: '',
    TABLE_NAME_GEARLISTING: '',
    TABLE_NAME_GEARISSUE: '',
    TABLE_NAME_VALIDATIONRESULT: '',
    TABLE_NAME_CONSUMABLESCORE: '',
    TABLE_NAME_DRUMSTAT: '',
    TABLE_NAME_SHADOWRESISTANCERESULT: '',
  },
});
