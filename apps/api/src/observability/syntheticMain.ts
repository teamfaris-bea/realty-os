// CLI for the synthetic production check: `pnpm ops:synthetic` (see synthetic.ts for the variables).
// One JSON line per step, then a summary line; exit 0 ok, 1 a step failed, 2 misconfigured.
import { runSynthetic, syntheticOptionsFromEnv } from './synthetic.js';

async function main(): Promise<number> {
  const cfg = syntheticOptionsFromEnv(process.env);
  if (!cfg.ok) {
    process.stderr.write(`${JSON.stringify({ check: 'synthetic', ok: false, reason: `missing configuration: ${cfg.missing.join(', ')}` })}\n`);
    return 2;
  }
  const r = await runSynthetic(cfg.options);
  for (const s of r.steps) process.stdout.write(`${JSON.stringify({ check: 'synthetic', ...s })}\n`);
  const line = JSON.stringify({ check: 'synthetic', ok: r.ok, reason: r.reason, totalMs: r.steps.reduce((n, s) => n + s.ms, 0) });
  if (r.ok) process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
  return r.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${JSON.stringify({ check: 'synthetic', ok: false, reason: `unexpected: ${(e as Error).name}` })}\n`);
    process.exit(1);
  },
);
