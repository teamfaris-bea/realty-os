// The accessibility sweep (e2e/a11y/a11y.spec.ts) opens every page of the registry as every role
// that can see it. This keeps its page list honest: a page added to the registry, or a change to who
// may open one, fails here until e2e/a11y/pages.ts says the same.
import { ROLES } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { ROLES as SWEEP_ROLES, SWEEP_PAGES } from '../../e2e/a11y/pages.js';
import { buildPageTable } from './pages.js';
import { surfaces } from './registry.js';
import { homeFallback } from './shellSurface.js';

describe('a11y sweep coverage', () => {
  const table = buildPageTable(surfaces, homeFallback);

  it('sweeps every role', () => {
    expect([...SWEEP_ROLES].sort()).toEqual([...ROLES].sort());
  });

  it('sweeps every registry page, as exactly the roles that may open it', () => {
    const registered = Object.fromEntries(table.pages.map((p) => [p.path, p.roles === 'all' ? [...ROLES].sort() : [...p.roles].sort()]));
    const swept = Object.fromEntries(SWEEP_PAGES.map((p) => [p.path, [...p.roles].sort()]));
    expect(swept).toEqual(registered);
  });
});
