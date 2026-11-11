import { defineAuth } from '@aws-amplify/backend';

/**
 * Admin accounts are provisioned directly (Amplify console / CLI), not via
 * self-service signup — ingest access is invite-only, not a public account
 * system. The "admins" group gates the report-ingest mutation and the
 * delete-report mutation; everyone else reads as an unauthenticated guest.
 * @see https://docs.amplify.aws/react/build-a-backend/auth/
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ['admins'],
});
