// b18 item f (owner product boundary, 2026-11-14): "No AI care for leads from this source" on a lead source's page:
// the Owner turns it on or off (PUT /lead-sources/:id/ai-care, re-auth when turning it off); anyone else sees the
// state and that only the Owner changes it. A made-up source name: no partner is named in the repository.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NO_AI_CARE_LABEL } from './Manage.js';
import { S1, overview, source, sourcesApp, sourcesFake } from './testing.js';

const page = `/admin/lead-sources/${S1}`;
const OFF = `${NO_AI_CARE_LABEL}: off. A lead's owner may start AI care as usual. Only the Owner changes this.`;
const ON = `${NO_AI_CARE_LABEL}: on. AI care cannot start for leads from this source (any record of the person), and care already running for them is paused and cannot be resumed. Only the Owner changes this.`;

describe('E723 a lead source\'s "No AI care for leads from this source" (b18 item f)', () => {
  it('E723: the Owner turns it on in one tap; the answer says how many lead\'s AI care will pause; the page then shows it on', async () => {
    let on = false;
    const fake = sourcesFake(overview([source({ name: 'Referral source (test)', noAiCare: false, noAiCareSentence: OFF })]));
    fake.on('GET /lead-sources/overview', () => ({ status: 200, body: overview([source({ name: 'Referral source (test)', noAiCare: on, noAiCareSentence: on ? ON : OFF })]) }));
    fake.on(`PUT /lead-sources/${S1}/ai-care`, () => {
      on = true;
      return { status: 200, body: { source: { id: S1, name: 'Referral source (test)', noAiCare: true, noAiCareSentence: ON }, pausing: 2 } };
    });
    sourcesApp(fake, page, 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText(OFF)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: `Turn on: ${NO_AI_CARE_LABEL.toLowerCase()}` }));
    await waitFor(() => expect(fake.callsTo(`PUT /lead-sources/${S1}/ai-care`)).toHaveLength(1));
    expect(fake.callsTo(`PUT /lead-sources/${S1}/ai-care`)[0]!.body).toEqual({ noAiCare: true });
    expect(await screen.findByText(`${NO_AI_CARE_LABEL} is on. AI care already running for 2 of its leads will pause.`)).toBeInTheDocument();
    expect(await screen.findByText(ON)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow AI care for leads from this source' })).toBeInTheDocument();
  });

  it('E723: an Admin sees the state and who changes it, with no button', async () => {
    sourcesApp(sourcesFake(overview([source({ noAiCare: true, noAiCareSentence: ON })])), page, 'admin');
    expect(await screen.findByText(ON)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AI care/i })).toBeNull();
  });
});
