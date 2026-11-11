import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { env } from '$amplify/env/delete-report';
import { recomputeRaidNight } from '../_shared/raidNight';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Same composite-key convention ingestReport writes with: a 3-part
// identifier (reportCode, fightId, characterName) becomes HASH=reportCode,
// RANGE="fightId#characterName" on the actual table.
const THREE_FIELD_CHILD_TABLES = [
  env.TABLE_NAME_GEARLISTING,
  env.TABLE_NAME_GEARISSUE,
  env.TABLE_NAME_CONSUMABLESCORE,
  env.TABLE_NAME_DRUMSTAT,
  env.TABLE_NAME_SHADOWRESISTANCERESULT,
  // Cast: Amplify's generated env types never pick up tables added after
  // the function's first deploy (see the ingest worker's GEMQUALITY note).
  (env as unknown as Record<string, string>).TABLE_NAME_DEATHRECORD,
  (env as unknown as Record<string, string>).TABLE_NAME_DAMAGESTAT,
];

async function deleteAllMatchingRows(tableName: string, reportCode: string, fightId: string) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'reportCode = :reportCode AND begins_with(#sk, :fightIdPrefix)',
      ExpressionAttributeNames: { '#sk': 'fightId#characterName' },
      ExpressionAttributeValues: {
        ':reportCode': reportCode,
        ':fightIdPrefix': `${fightId}#`,
      },
    })
  );
  await Promise.all(
    (res.Items ?? []).map((item) =>
      ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { reportCode, 'fightId#characterName': item['fightId#characterName'] },
        })
      )
    )
  );
}

export const handler = async (event: { arguments: { reportCode: string; fightId: string } }) => {
  const { reportCode, fightId } = event.arguments;

  await Promise.all(
    THREE_FIELD_CHILD_TABLES.map((tableName) => deleteAllMatchingRows(tableName, reportCode, fightId))
  );

  // Report itself goes before the shared ValidationResult check below, so
  // that check sees the post-delete state of the report code's encounters.
  await ddb.send(
    new DeleteCommand({
      TableName: env.TABLE_NAME_REPORT,
      Key: { reportCode, fightId },
    })
  );

  // The list's per-raid summary (boss/kill counts) must reflect this delete;
  // the helper also removes the raid's row once its last boss attempt is gone.
  await recomputeRaidNight(
    ddb,
    {
      report: env.TABLE_NAME_REPORT,
      raidNight: (env as unknown as Record<string, string>).TABLE_NAME_RAIDNIGHT,
      deathRecord: (env as unknown as Record<string, string>).TABLE_NAME_DEATHRECORD,
      gearListing: env.TABLE_NAME_GEARLISTING,
    },
    reportCode
  );

  // ValidationResult is one row per reportCode — shared across every
  // encounter in the raid night, not scoped to this one fight — so it's
  // only safe to delete once no other Report rows for this reportCode
  // remain. Deleting a single encounter otherwise must never take the
  // shared validation result down with it.
  const remaining = await ddb.send(
    new QueryCommand({
      TableName: env.TABLE_NAME_REPORT,
      KeyConditionExpression: 'reportCode = :reportCode',
      ExpressionAttributeValues: { ':reportCode': reportCode },
      Limit: 1,
    })
  );
  if (!remaining.Items || remaining.Items.length === 0) {
    await ddb.send(
      new DeleteCommand({
        TableName: env.TABLE_NAME_VALIDATIONRESULT,
        Key: { reportCode },
      })
    );
  }

  return { success: true };
};
