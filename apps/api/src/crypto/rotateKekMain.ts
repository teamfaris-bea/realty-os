// node apps/api/dist/crypto/rotateKekMain.js — master KEK rotation (docs/DEPLOY.md "KEK rotation").
//   MIGRATION_DATABASE_URL                   owner role
//   PREVIOUS_KEK_BASE64 / PREVIOUS_KEK_REF   the KEK in use now
//   KEK_BASE64 / KEK_REF                     the new KEK (what api and worker start with afterwards)
// Prints counts only, never keys.
import pg from 'pg';
import { localKek } from './kek.js';
import { rotateKek } from './rotateKek.js';

function key(name: string): Uint8Array {
  const b = Buffer.from(process.env[name] ?? '', 'base64');
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes of base64`);
  return new Uint8Array(b);
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  const fromRef = process.env.PREVIOUS_KEK_REF;
  const toRef = process.env.KEK_REF;
  if (!url || !fromRef || !toRef) throw new Error('MIGRATION_DATABASE_URL, PREVIOUS_KEK_REF and KEK_REF must be set');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  // An idle client can be terminated by the server (a test database dropped WITH (FORCE), a restart):
  // without a listener pg re-throws it as an unhandled error. Queries in flight still reject normally.
  pool.on('error', () => {});
  try {
    const r = await rotateKek(pool, localKek(key('PREVIOUS_KEK_BASE64'), fromRef), localKek(key('KEK_BASE64'), toRef));
    console.log(`kek rotation ok: ${r.tenantKeys} tenant keys re-wrapped, ${r.mfaSecrets} MFA secrets and ${r.webhookPayloads} webhook payloads re-encrypted, ${r.alreadyRotated} already under the new KEK`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(`kek rotation failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
