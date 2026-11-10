// The authenticator deep link on MFA enrollment comes from the API response; it is rendered into an
// href only if it is an otpauth: URI (defence in depth against a tampered or buggy response).
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../testing/fakeApi.js';

const table = tableWith({ pages: [] });
const enrolling = sessionFixture({ tenant: { ...sessionFixture().tenant!, role: 'owner' }, mfa: { enabled: false, verified: false, enrollmentRequired: true } });

function enrollWith(otpauthUri: string) {
  const fake = new FakeFetch()
    .on('GET /auth/session', { status: 200, body: enrolling })
    .on('POST /auth/mfa/enroll', { status: 200, body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri } });
  renderApp({ fake, path: '/mfa/enroll', table });
}

describe('MFA enrollment authenticator link', () => {
  it('links an otpauth: URI', async () => {
    enrollWith('otpauth://totp/Realty%20OS:pat?secret=JBSWY3DPEHPK3PXP');
    expect(await screen.findByRole('link', { name: 'Open in authenticator app' })).toHaveAttribute('href', 'otpauth://totp/Realty%20OS:pat?secret=JBSWY3DPEHPK3PXP');
  });

  it('never renders a javascript: URI as a link', async () => {
    enrollWith('javascript:alert(document.cookie)');
    expect(await screen.findByLabelText('Setup key')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in authenticator app' })).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });
});
