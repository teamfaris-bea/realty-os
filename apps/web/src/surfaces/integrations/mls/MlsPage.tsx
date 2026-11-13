// The MLS page (module 41 extends the Spark prep's Connect MLS page in place): sync status, "MLS data as of",
// whether MLS data may reach clients and why not, the licence-pack editor and its valuation section ("Valuation use",
// D9: where an Owner or Admin records that sold data may be used for valuations; MlsStatus), then the Spark key
// entry, validation and disconnect exactly as the Spark prep built them (SparkPage).
import { MlsStatus } from './MlsStatus.js';
import SparkPage from './SparkPage.js';

export default function MlsPage() {
  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col gap-8">
      <MlsStatus />
      <SparkPage />
    </div>
  );
}
