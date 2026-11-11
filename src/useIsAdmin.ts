import { useEffect, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

// `null` while checking, then true/false. Used to conditionally show
// admin-only UI (the ingest screen's content, the reports list's delete
// button) — the actual enforcement always happens server-side in the
// ingestReport/deleteReport mutations themselves; this is just for the UI.
export function useIsAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthSession()
      .then((session) => {
        if (cancelled) return;
        const groups = (session.tokens?.accessToken.payload['cognito:groups'] as string[] | undefined) ?? [];
        setIsAdmin(groups.includes('admins'));
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
