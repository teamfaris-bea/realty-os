// Platform alerts (worker/observability.ts AlertSink) as metrics and error reports: every alert still
// goes to its sink (the structured `alert` log line), and is also counted (realty_alerts_total) and sent
// to the error reporter as a warning (P2) or error (P1), with codes and the job kind only.
import type { Alert, AlertSink } from '../worker/observability.js';
import type { ErrorReporter } from './errors.js';
import type { Registry } from './prometheus.js';

export class PlatformAlertError extends Error {
  override readonly name = 'PlatformAlert';
}

export function observedAlerts(sink: AlertSink, registry: Registry, reporter: ErrorReporter): AlertSink {
  const count = registry.counter('realty_alerts_total', 'Platform alerts raised by the worker, by code and severity.');
  return {
    raise(a: Alert) {
      sink.raise(a);
      count.inc({ code: a.code, severity: a.severity });
      const kind = typeof a.details.kind === 'string' ? a.details.kind : undefined;
      reporter.capture(new PlatformAlertError(`${a.code} (${a.severity})`), { code: a.code, ...(kind ? { jobKind: kind } : {}), process: 'worker', level: a.severity === 'P1' ? 'error' : 'warning' });
    },
  };
}
