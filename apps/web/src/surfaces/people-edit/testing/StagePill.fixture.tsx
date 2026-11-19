// Synthetic component fixture: no API server, database, lead data or providers.
import '../../../design/tokens.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApiClient } from '../../../shell/api.js';
import { ShellProvider } from '../../../shell/context.js';
import { StagePill } from '../StagePill.js';
import { ToastProvider } from '../hooks.js';
import type { Details } from '../api.js';

const details: Details = {
  contactId: '01900000-0000-7000-8000-0000000c0001', rowVersion: 1, doNotContact: false,
  stage: { stage: 'new', label: 'New', locked: ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'], lockedReason: 'STAGE_NEEDS_CONTACT' },
  stageLabels: { under_contract: 'ABCDEFGHIJKLMNOPQRSTUVWX' },
  addresses: [], collaborators: [], relationships: [], removedPoints: [], canEdit: true, canManageCollaborators: false,
};
// Browser routes answer every request; a missing route is an explicit test failure.
const api = new ApiClient();
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellProvider api={api} table={{ pages: [], errorMessages: {}, evidenceRoutes: {} }}>
      <MemoryRouter><ToastProvider>
        <StagePill contactId={details.contactId} name="Synthetic Person" details={details} onCall={() => undefined} onText={() => undefined} onReplyChat={() => undefined} />
      </ToastProvider></MemoryRouter>
    </ShellProvider>
  </QueryClientProvider>,
);
