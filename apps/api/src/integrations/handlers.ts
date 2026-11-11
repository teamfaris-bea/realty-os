// Job handlers of api/integrations (registered in worker/handlers/index.ts).
//
//   integrations.revoke_grant   after a disconnect (whose transaction already revoked the credential
//                               locally): decrypt the token as the system actor (R-INT-4), revoke it at
//                               the provider (best effort: a provider failure is logged, never retried
//                               forever), then purge the secret. The retention sweep would purge it within
//                               30 days anyway (purge_after), so nothing depends on this job succeeding.
import { loadConfig } from '../config.js';
import { EnvelopeService } from '../crypto/envelope.js';
import { localKek } from '../crypto/kek.js';
import type { OAuthToken } from '../providers/integrations/types.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { REVOKE_GRANT_JOB, type RevokeGrantPayload } from './jobs.js';
import * as repo from './repos/connections.js';

let envelopeRuntime: EnvelopeService | null = null;
const defaultEnvelope = (): EnvelopeService => {
  if (!envelopeRuntime) {
    const cfg = loadConfig();
    envelopeRuntime = new EnvelopeService(localKek(cfg.kek, cfg.kekRef));
  }
  return envelopeRuntime;
};

export function makeIntegrationHandlers(envelopeFor: () => EnvelopeService = defaultEnvelope): JobHandler<unknown>[] {
  const revoke: TxJobHandler<RevokeGrantPayload> = {
    ...REVOKE_GRANT_JOB,
    via: 'provider',
    async run(ctx, p) {
      const c = await repo.loadCredential(ctx.tx, p.credentialId);
      if (!c || c.status !== 'revoked' || !c.secret_enc) return;
      if (c.provider === 'meta' || c.provider === 'google') {
        try {
          const pt = await envelopeFor()
            .inTx(ctx.tx, ctx.actor.tenantId)
            .decrypt(ctx.actor.tenantId, { table: 'provider_credentials', column: 'secret_enc', rowId: p.credentialId }, new Uint8Array(c.secret_enc));
          const token = JSON.parse(new TextDecoder().decode(pt)) as OAuthToken;
          await ctx.providers.integrations.oauth[c.provider].revoke(token);
        } catch (e) {
          ctx.log.warn('integration grant revoke at provider failed (best effort)', { kind: REVOKE_GRANT_JOB.kind, code: e instanceof Error ? e.name : 'unknown' });
        }
      }
      await repo.purgeCredential(ctx.tx, p.credentialId);
    },
  };
  return [revoke] as JobHandler<unknown>[];
}

export const integrationHandlers: JobHandler<unknown>[] = makeIntegrationHandlers();
