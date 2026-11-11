import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * Thin adapter around the Warcraft Logs API: v1 REST for report data, v2 GraphQL (OAuth) for parse
 * rankings and crit records. Nothing else in the backend should know WCL's request/response shape —
 * that isolation is what let v2 be added for rankings without touching the ingest code that consumes it.
 */
export const wclClient = defineFunction({
  name: 'wcl-client',
  entry: './handler.ts',
  environment: {
    WCL_API_KEY: secret('wclApiKey'),
    // OAuth client credentials for the v2 GraphQL API, used only for per-fight
    // parse rankings (see getFightRankings in handler.ts). Create the client
    // at https://classic.warcraftlogs.com/api/clients and set both as Amplify
    // secrets — sandbox via `npx ampx sandbox secret set`, production via the
    // Amplify console (Hosting > Secrets).
    WCL_CLIENT_ID: secret('wclClientId'),
    WCL_CLIENT_SECRET: secret('wclClientSecret'),
    // Overridable per-call (see handler.ts) — the original tool supported
    // reports from both classic.warcraftlogs.com and fresh.warcraftlogs.com,
    // and we don't yet know which one this project's reports live on.
    WCL_DEFAULT_BASE_URL: 'https://classic.warcraftlogs.com/v1',
  },
  timeoutSeconds: 30,
});
