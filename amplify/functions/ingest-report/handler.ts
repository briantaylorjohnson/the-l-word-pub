import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { env } from '$amplify/env/ingest-report';
import type { ReportFightsResponse } from '../wcl-client/handler';

const lambdaClient = new LambdaClient({});

async function invokeWclClient<T>(payload: Record<string, unknown>): Promise<T> {
  const res = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: env.WCL_CLIENT_FUNCTION_NAME,
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
  if (!res.Payload) throw new Error('wcl-client returned no payload');
  const body = JSON.parse(Buffer.from(res.Payload).toString('utf-8'));
  if (res.FunctionError) {
    throw new Error(`wcl-client error: ${body.errorMessage ?? JSON.stringify(body)}`);
  }
  return body as T;
}

// Fast trigger only — AppSync's Lambda-resolver timeout is a hard 30s,
// far too short to process a full raid night (a live 51-fight report
// needs well over a thousand WarcraftLogs calls). This fetches just the
// fight list, fires the real work at ingest-report-worker asynchronously
// (fire-and-forget — InvocationType 'Event' returns as soon as the
// invoke is accepted, not when the worker finishes), and returns
// immediately. Encounters appear in the Reports list progressively as
// the worker finishes each one.
export const handler = async (event: {
  arguments: { reportCode: string; baseUrl?: string | null };
}) => {
  const { reportCode, baseUrl } = event.arguments;
  const resolvedBaseUrl = baseUrl ?? env.WCL_DEFAULT_BASE_URL;

  const reportFights = await invokeWclClient<ReportFightsResponse>({
    action: 'getReportFights',
    reportCode,
    baseUrl: resolvedBaseUrl,
  });

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: env.INGEST_WORKER_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ reportCode, baseUrl: resolvedBaseUrl })),
    })
  );

  return {
    title: reportFights.title,
    zone: reportFights.fights[0]?.zoneName ?? null,
    fightCount: reportFights.fights.length,
  };
};
