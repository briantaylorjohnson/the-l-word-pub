import { defineFunction } from '@aws-amplify/backend';

/**
 * Deletes a report and every row derived from it — the admin-only
 * counterpart to ingestReport. DynamoDB has no cascade-delete, so this
 * queries each child table by reportCode/fightId and batch-deletes the
 * matches itself, deleting the Report row last so a crash mid-delete
 * never leaves an orphaned Report pointing at partially-deleted data.
 *
 * Table-name env values are placeholders — backend.ts fills in the real
 * ones (unknown until synth) via `addEnvironment`.
 */
export const deleteReport = defineFunction({
  name: 'delete-report',
  entry: './handler.ts',
  timeoutSeconds: 60,
  // Same reasoning as ingest-report: a custom mutation's handler that
  // also grants itself direct table access creates a circular dependency
  // between the default "function" stack and the "data" stack unless it
  // lives in the data stack instead.
  resourceGroupName: 'data',
  environment: {
    TABLE_NAME_REPORT: '',
    TABLE_NAME_GEARLISTING: '',
    TABLE_NAME_GEARISSUE: '',
    TABLE_NAME_CONSUMABLESCORE: '',
    TABLE_NAME_DRUMSTAT: '',
    TABLE_NAME_SHADOWRESISTANCERESULT: '',
    TABLE_NAME_VALIDATIONRESULT: '',
  },
});
