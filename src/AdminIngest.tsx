import { useEffect, useState } from 'react';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Link } from 'react-router-dom';
import { dataClient } from './amplifyDataClient';
import { PageHeader } from './PageHeader';

function IngestForm() {
  const { signOut, user } = useAuthenticator((ctx) => [ctx.user]);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [reportCode, setReportCode] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string | null; zone: string | null; fightCount: number } | null>(
    null
  );
  const [status, setStatus] = useState<
    { state: 'waiting' } | { state: 'done'; total: number; failed: number; errors: string[] } | null
  >(null);

  // The trigger returns as soon as the worker is handed off, so success
  // there only means "started". Poll the outcome the worker records when
  // it finishes — otherwise a half-ingested raid looks identical to a
  // clean one and quietly goes missing from the reports list.
  async function pollIngestStatus(code: string) {
    setStatus({ state: 'waiting' });
    const startedAt = Date.now();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await dataClient.models.IngestStatus.get({ reportCode: code }, { authMode: 'userPool' });
        const row = res.data;
        if (row?.finishedAt && new Date(row.finishedAt).getTime() >= startedAt) {
          setStatus({
            state: 'done',
            total: row.encountersTotal ?? 0,
            failed: row.encountersFailed ?? 0,
            errors: (JSON.parse((row.errors as unknown as string) ?? '[]') as string[]) ?? [],
          });
          return;
        }
      } catch {
        // keep polling — a transient read failure shouldn't end the watch
      }
    }
    setStatus(null);
  }

  useEffect(() => {
    // Signing in only proves you're one of the (invite-only, admin-created)
    // Cognito users — the ingestReport mutation itself is what actually
    // enforces `admins` group membership. This check just gives a clear
    // message instead of a raw GraphQL authorization error if that ever
    // diverges (e.g. an account created but never added to the group).
    fetchAuthSession().then((session) => {
      const groups = (session.tokens?.accessToken.payload['cognito:groups'] as string[] | undefined) ?? [];
      setIsAdmin(groups.includes('admins'));
    });
  }, []);

  async function handleIngest() {
    setLoading(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const res = await dataClient.mutations.ingestReport(
        { reportCode, baseUrl: baseUrl || undefined },
        { authMode: 'userPool' }
      );
      if (res.errors && res.errors.length > 0) {
        throw new Error(res.errors.map((e) => e.message).join('; '));
      }
      if (!res.data) throw new Error('Ingest returned no data.');
      setResult({ title: res.data.title, zone: res.data.zone, fightCount: res.data.fightCount });
      pollIngestStatus(reportCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (isAdmin === null) {
    return (
      <>
        <PageHeader
          title={
            <>
              Admin <span className="accent">Ingest</span>
            </>
          }
        />
        <p className="loading-note">Checking permissions…</p>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeader
          title={
            <>
              Admin <span className="accent">Ingest</span>
            </>
          }
        />
        <div className="alert error">
          Signed in as {user?.signInDetails?.loginId ?? 'unknown user'}, but this account isn't in the admins
          group.
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </>
    );
  }

  const signOutButton = (
    <button className="btn btn-ghost btn-sm" onClick={signOut}>
      Sign Out
    </button>
  );

  return (
    <>
      <PageHeader
        title={
          <>
            Admin <span className="accent">Ingest</span>
          </>
        }
        subtitle="Pull an entire raid night from WarcraftLogs, by report code"
        actions={signOutButton}
      />

      <div className="panel">
        <div className="panel-body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleIngest();
            }}
          >
            <div className="form-grid">
              <div className="field">
                <label>Report Code</label>
                <input value={reportCode} onChange={(e) => setReportCode(e.target.value)} />
              </div>
              <div className="field">
                <label>Base URL (optional)</label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://classic.warcraftlogs.com/v1"
                />
              </div>
            </div>
            <button type="submit" className="btn btn-gold" disabled={loading || !reportCode}>
              {loading ? 'Starting ingest…' : 'Ingest whole raid'}
            </button>
          </form>

          {error && <div className="alert error">{error}</div>}
          {result && (
            <div className="alert success">
              Started ingest for <strong>{result.title ?? reportCode}</strong>
              {result.zone ? ` — ${result.zone}` : ''}: {result.fightCount}{' '}
              {result.fightCount === 1 ? 'fight' : 'fights'} found (bosses and trash alike). Each one is
              processed in the background and will appear on the <Link to="/">Reports list</Link> as it
              finishes — a full raid night can take a minute or two.
            </div>
          )}

          {status?.state === 'waiting' && <p className="loading-note">Watching the ingest…</p>}
          {status?.state === 'done' &&
            (status.failed === 0 ? (
              <div className="alert success">
                Ingest finished cleanly — all {status.total} encounters processed.
              </div>
            ) : (
              <div className="alert error">
                <strong>
                  {status.failed} of {status.total} encounters failed
                </strong>{' '}
                — those encounters are missing from this raid. Re-run the ingest; if it fails again, the
                errors below say why.
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {status.errors.map((e, i) => (
                    <li key={i} style={{ fontSize: 12 }}>
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

// Cognito accounts here are invite-only (admin-created, no self-signup) —
// hideSignUp keeps the Authenticator's default sign-up tab from appearing.
export function AdminIngest() {
  return (
    <Authenticator hideSignUp>
      <IngestForm />
    </Authenticator>
  );
}
