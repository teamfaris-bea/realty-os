// Job contracts of api/integrations (payloads: ids only, R-TEN-7).
import { jobPayload, zId } from '../worker/payload.js';

export const RevokeGrantPayload = jobPayload({ credentialId: zId });
export type RevokeGrantPayload = { credentialId: string };

/** integrations.revoke_grant: best-effort revocation at the provider, then the secret is purged (R-INT-5). */
export const REVOKE_GRANT_JOB = { kind: 'integrations.revoke_grant', queue: 'default', schema: RevokeGrantPayload, maxAttempts: 3 } as const;
