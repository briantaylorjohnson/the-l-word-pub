import { fetchAuthSession } from 'aws-amplify/auth';

// All read calls (list/get) need to pick their authMode explicitly rather
// than rely on the client's default (identityPool). identityPool resolves
// to the Cognito Identity Pool's *unauthenticated* IAM role for a
// signed-out visitor, but its *authenticated* IAM role for anyone signed
// in — including an admin who's just logged in to use /admin. The
// deployed AppSync resolvers' own authorization step (independent of IAM
// policy) only ever recognizes the unauthenticated role for these
// public-read models, so identityPool reads go silently Unauthorized the
// moment someone signs in (confirmed against the real deployed API — see
// the comment on `publicReadAdminWrite` in amplify/data/resource.ts).
// Cognito User Pool auth mode's resolver branch, by contrast, authorizes
// any signed-in caller for these read-only fields — so: use `userPool`
// whenever a real session exists, and fall back to the client default
// (`identityPool`, which works for guests) when it doesn't. `userPool`
// mode throws ("No federated jwt") if attempted with no session, so this
// can't just be used unconditionally.
export async function getReadAuthMode(): Promise<'userPool' | undefined> {
  try {
    const session = await fetchAuthSession();
    return session.tokens ? 'userPool' : undefined;
  } catch {
    return undefined;
  }
}
