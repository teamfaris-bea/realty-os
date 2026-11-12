// pnpm --filter @realty/db counsel-review -- --keys platform:<name>@<version>[,...] --reviewed-on YYYY-MM-DD --reference "<source>" [--apply]
// pnpm --filter @realty/db counsel-review -- --revoke --keys platform:<name>@<version>[,...] --reference "<source>" [--apply]
// (in the api image: node packages/db/dist/scripts/counsel-review.js <same flags>)
// Records (or withdraws) counsel review of pinned platform clearance pack versions on MIGRATION_DATABASE_URL (the
// owner role), as migrate does; dry run by default. What it changes and refuses: src/counselReview.ts and
// docs/DEPLOY.md §10.1.
import { runCounselReview } from '../counselReview.js';
import { loadRootEnv } from '../dbConfig.js';

loadRootEnv();
const code = await runCounselReview(process.argv.slice(2), {
  url: process.env.MIGRATION_DATABASE_URL,
  log: (l) => console.log(l),
  error: (l) => console.error(l),
});
process.exit(code);
