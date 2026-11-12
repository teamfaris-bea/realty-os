// The milestone templates page in jsdom (module 41; R-TXN-6, R-AUDIT-5 display): templates are listed with "Not
// reviewed by counsel" where true, invalid entries are shown by their position, a counsel statement is a checkbox the
// Owner/Admin saves with the list, and the server's refusal names each bad entry. The fifth queue type (finding 8).
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../../shell/testing/fakeApi.js';
import { err } from '../../../shell/testing/fakeApi.js';
import { TYPES, TYPE_LABEL, TYPE_PLURAL } from '../../team/lib.js';
import { surface } from './index.js';
import { parseEditor, setReviewed, type TemplatesResponse } from './lib.js';

const T = { id: 'purchase', version: 1, name: 'Purchase', side: 'buy', jurisdiction: 'US', reviewed: false, rules: [{ key: 'inspection', kind: 'inspection', offsetDays: 10, dayCount: 'business' }] };

function body(over: Partial<TemplatesResponse> = {}): TemplatesResponse {
  return { templates: [T, { id: 'bad' }], parsed: [{ id: 'purchase', version: 1, name: 'Purchase', side: 'buy', jurisdiction: 'US', reviewed: false, rules: 1 }], invalid: [{ index: 1, error: 'version: Invalid input' }], jurisdictions: ['US'], ...over };
}

function app(fake: FakeFetch, role: 'owner' | 'admin' = 'owner') {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path: '/admin/milestone-templates', table: tableWith(surface) });
}

describe('milestone templates page', () => {
  it('R-TXN-6: lists templates with "Not reviewed by counsel", and invalid stored entries by position', async () => {
    app(new FakeFetch().on('GET /settings/milestone-templates', { status: 200, body: body() }));
    expect(await screen.findByText('Purchase')).toBeInTheDocument();
    expect(screen.getAllByText('Not reviewed by counsel').length).toBeGreaterThanOrEqual(2); // the page banner and the template
    expect(screen.getByText('Entry 2: version: Invalid input')).toBeInTheDocument();
  });

  it('R-AUDIT-5: the counsel statement is a checkbox saved with the list; a refusal lists the bad entries and saves nothing', async () => {
    const fake = new FakeFetch()
      .on('GET /settings/milestone-templates', { status: 200, body: body({ templates: [T], invalid: [] }) })
      .on('PUT /settings/milestone-templates', err(422, 'MILESTONE_TEMPLATES_INVALID', { invalid: [{ index: 0, error: 'rules.0.offsetDays: Too big' }] }));
    app(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Counsel reviewed this template (your statement)'));
    await user.click(screen.getByRole('button', { name: 'Save templates' }));
    await waitFor(() => expect(fake.callsTo('PUT /settings/milestone-templates')).toHaveLength(1));
    expect((fake.callsTo('PUT /settings/milestone-templates')[0]!.body as { templates: { reviewed: boolean }[] }).templates[0]!.reviewed).toBe(true);
    expect(await screen.findByText('Entry 1: rules.0.offsetDays: Too big')).toBeInTheDocument();
  });

  it('editor helpers: invalid JSON is refused before any request; setReviewed changes only that entry', () => {
    expect(parseEditor('{').ok).toBe(false);
    expect(parseEditor('{}')).toEqual({ ok: false, error: expect.stringMatching(/must be a list/) });
    const text = JSON.stringify([T, { ...T, id: 'other' }]);
    const next = JSON.parse(setReviewed(text, 'purchase@1', true)!) as { id: string; reviewed: boolean }[];
    expect(next.map((x) => [x.id, x.reviewed])).toEqual([['purchase', true], ['other', false]]);
  });

  it('finding 8: the Team Lead queue knows milestone_at_risk (label, plural, filter)', () => {
    expect(TYPES).toContain('milestone_at_risk');
    expect(TYPE_LABEL.milestone_at_risk).toBe('Milestone at risk');
    expect(TYPE_PLURAL.milestone_at_risk).toBe('Milestones at risk');
  });
});
