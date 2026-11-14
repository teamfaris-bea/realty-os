// b18 item f (owner product boundary, 2026-11-14), renamed by b18 review B18S-5: "No automated contact for leads from
// this source" on a lead source's page: the Owner turns it on or off (PUT /lead-sources/:id/ai-care, re-auth when
// turning it off); anyone else sees the state and that only the Owner changes it. A made-up source name: no partner is
// named in the repository.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NO_AUTOMATED_CONTACT_LABEL } from './Manage.js';
import { S1, overview, source, sourcesApp, sourcesFake } from './testing.js';

const page = `/admin/lead-sources/${S1}`;
const OFF = `${NO_AUTOMATED_CONTACT_LABEL}: off. Leads from this source get the team's automatic replies, plans and AI care as usual. Only the Owner changes this.`;
const ON = `${NO_AUTOMATED_CONTACT_LABEL}: on. Nothing automatic reaches leads from this source (any record of the person): no instant reply, no plan, no bulk text, email or invite, no AI care and no AI-answered call. Plans and AI care already running for them stop or pause. People an import brought in count once the Owner maps their imported source label to this source. People on the team can still call, text and email them one to one. Only the Owner changes this.`;

describe('E727 a lead source\'s "No automated contact for leads from this source" (b18 item f, B18S-5)', () => {
  it('B18S-5: the setting is named honestly: "No automated contact for leads from this source", never "No AI care"', () => {
    expect(NO_AUTOMATED_CONTACT_LABEL).toBe('No automated contact for leads from this source');
  });

  it('E727: the Owner turns it on in one tap; the answer says how many leads\' AI care will pause and how many plans will stop; the page then shows it on', async () => {
    let on = false;
    const fake = sourcesFake(overview([source({ name: 'Referral source (test)', noAiCare: false, noAiCareSentence: OFF })]));
    fake.on('GET /lead-sources/overview', () => ({ status: 200, body: overview([source({ name: 'Referral source (test)', noAiCare: on, noAiCareSentence: on ? ON : OFF })]) }));
    fake.on(`PUT /lead-sources/${S1}/ai-care`, () => {
      on = true;
      return { status: 200, body: { source: { id: S1, name: 'Referral source (test)', noAiCare: true, noAiCareSentence: ON }, pausing: 2, stopping: 1 } };
    });
    sourcesApp(fake, page, 'owner');
    const u = userEvent.setup();
    expect(await screen.findByText(OFF)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: `Turn on: ${NO_AUTOMATED_CONTACT_LABEL.toLowerCase()}` }));
    await waitFor(() => expect(fake.callsTo(`PUT /lead-sources/${S1}/ai-care`)).toHaveLength(1));
    expect(fake.callsTo(`PUT /lead-sources/${S1}/ai-care`)[0]!.body).toEqual({ noAiCare: true });
    expect(await screen.findByText(`${NO_AUTOMATED_CONTACT_LABEL} is on. AI care already running for 2 of its leads will pause. Plans running for 1 of its lead will stop.`)).toBeInTheDocument();
    expect(await screen.findByText(ON)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow automated contact for leads from this source' })).toBeInTheDocument();
  });

  it('E727: an Admin sees the state and who changes it, with no button', async () => {
    sourcesApp(sourcesFake(overview([source({ noAiCare: true, noAiCareSentence: ON })])), page, 'admin');
    expect(await screen.findByText(ON)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /automated contact/i })).toBeNull();
  });
});
