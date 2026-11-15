// No .env autoload: the operator must explicitly provide the existing migration connection.
import { runLegacyDeliveryReport } from '../legacyDeliveryPreflight.js';
import { databaseTlsFromEnv, pgSsl } from '../tls.js';
let ssl: ReturnType<typeof pgSsl>;
try { ssl=pgSsl(databaseTlsFromEnv(process.env,['MIGRATION_DATABASE_URL'])); }
catch { console.error('LEGACY_REPORT_TLS_CONFIGURATION_INVALID'); process.exit(1); }
process.exitCode=await runLegacyDeliveryReport(process.argv.slice(2),{
  url:process.env.MIGRATION_DATABASE_URL,ssl,out:line=>console.log(line),
});
