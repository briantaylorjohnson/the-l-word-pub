#!/usr/bin/env node
/**
 * Batch-loads seed JSON (produced by extract_reference_data.py) directly
 * into the DynamoDB table Amplify generated for a given model — bypassing
 * the AppSync API entirely, since this is a one-off admin seeding step, not
 * something that needs to go through GraphQL auth rules.
 *
 * Requires: a deployed backend (`npx ampx sandbox` or a real deploy) and
 * AWS credentials on this machine with dynamodb:ListTables/BatchWriteItem.
 * Amplify Gen 2 doesn't expose raw table names in amplify_outputs.json, so
 * this looks the table up by name prefix — override with --table-name if
 * more than one table matches.
 *
 * Usage:
 *   node load_to_dynamodb.mjs --model ItemSocket --file data/item-sockets.json
 *   node load_to_dynamodb.mjs --model ShadowResistanceItem --file data/shadow-resistance-items.json [--table-name <exact-name>]
 */

import { readFileSync } from 'node:fs';
import {
  DynamoDBClient,
  ListTablesCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function resolveTableName(client, modelName, explicitName) {
  if (explicitName) return explicitName;

  const tableNames = [];
  let exclusiveStartTableName;
  do {
    const res = await client.send(
      new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName })
    );
    tableNames.push(...(res.TableNames ?? []));
    exclusiveStartTableName = res.LastEvaluatedTableName;
  } while (exclusiveStartTableName);

  const matches = tableNames.filter((name) => name.startsWith(`${modelName}-`));
  if (matches.length === 0) {
    throw new Error(
      `No DynamoDB table found starting with "${modelName}-". Has the backend been deployed (npx ampx sandbox)?`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple tables match "${modelName}-": ${matches.join(', ')}. Pass --table-name to disambiguate.`
    );
  }
  return matches[0];
}

async function batchWriteAll(client, tableName, items) {
  const CHUNK_SIZE = 25; // DynamoDB BatchWriteItem limit
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const command = new BatchWriteItemCommand({
      RequestItems: {
        [tableName]: chunk.map((item) => ({
          PutRequest: { Item: marshall(item) },
        })),
      },
    });
    const res = await client.send(command);
    if (res.UnprocessedItems && Object.keys(res.UnprocessedItems).length > 0) {
      throw new Error(
        `DynamoDB reported unprocessed items in chunk starting at index ${i} — retry needed.`
      );
    }
    console.log(`  wrote ${Math.min(i + CHUNK_SIZE, items.length)}/${items.length}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model || !args.file) {
    console.error(
      'Usage: node load_to_dynamodb.mjs --model <ModelName> --file <path.json> [--table-name <exact-name>]'
    );
    process.exit(1);
  }

  const rawItems = JSON.parse(readFileSync(args.file, 'utf-8'));
  // Amplify Data declares createdAt/updatedAt non-nullable on every model.
  // Rows only ever read by Lambdas (direct DynamoDB) don't care, but any
  // table read through AppSync fails per-row schema validation without
  // them — the whole item comes back null to the client. Inject timestamps
  // so seeded reference data is safe to read either way.
  const now = new Date().toISOString();
  const items = rawItems.map((item) => ({ createdAt: now, updatedAt: now, ...item }));
  const client = new DynamoDBClient({});
  const tableName = await resolveTableName(client, args.model, args['table-name']);

  console.log(`Loading ${items.length} items into ${tableName}`);
  await batchWriteAll(client, tableName, items);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
