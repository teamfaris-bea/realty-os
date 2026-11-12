// Design components: GateBadge, EvidenceLink / ClaimLine, Ratio, Button, TextField.
//
// Display half of R-AST-13 (no confidence anywhere) and of R-ACC-4 (every number shows its
// denominator): these components have no field for a score and cannot render a bare count. The
// rules themselves are proven where DATA_MODEL places them (API schema snapshots, DB views), so the
// ids are mentioned here, not claimed in test names.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SOURCE_TYPES, formatEvidence, type Locator } from '@realty/core/assistant';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  ClaimLine,
  EvidenceLink,
  EvidenceRoutesProvider,
  GateBadge,
  Ratio,
  TextField,
  evidenceText,
  formatEvidenceLine,
  type EvidenceRefView,
  type GateDecisionView,
} from './index.js';

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

describe('GateBadge', () => {
  it('a block shows the server explanation verbatim after plain words, with a non-color cue', () => {
    const { container } = render(<GateBadge decision={{ outcome: 'deny', explanation: 'Opted out of texts' }} />);
    expect(screen.getByText('Opted out of texts')).toBeInTheDocument();
    expect(container.textContent).toBe("Won't send: Opted out of texts");
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-gate-outcome', 'deny');
  });

  it('the words before the reason follow the action (a call, or a send that was just blocked)', () => {
    const { container, rerender } = render(<GateBadge lead="Won't call" decision={{ outcome: 'deny', explanation: 'Asked not to be called' }} />);
    expect(container.textContent).toBe("Won't call: Asked not to be called");
    rerender(<GateBadge lead="Not sent" decision={{ outcome: 'deny', explanation: 'Unsubscribed from email' }} />);
    expect(container.textContent).toBe('Not sent: Unsubscribed from email');
  });

  it('an allow is quiet when asked, and otherwise only says it is OK (there is nothing to wait for or confirm)', () => {
    const { container, rerender } = render(<GateBadge quietWhenAllowed decision={{ outcome: 'allow', explanation: 'OK to send' }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<GateBadge decision={{ outcome: 'allow', explanation: 'OK to send' }} />);
    expect(container.textContent).toBe('OK to send');
    expect(container.firstElementChild).toHaveAttribute('data-gate-outcome', 'allow');
  });

  it('never renders reason codes or extra fields the server might add (no scores)', () => {
    const decision = { outcome: 'deny', explanation: 'Opted out of texts', reasonCodes: ['CONSENT_REVOKED'], confidence: 0.92, score: 77 } as unknown as GateDecisionView;
    const { container } = render(<GateBadge decision={decision} />);
    expect(container.textContent).not.toMatch(/CONSENT_REVOKED|0\.92|92|77|confidence|score/i);
  });
});

describe('EvidenceLink', () => {
  const callRef: EvidenceRefView = {
    sourceType: 'call',
    sourceId: 'call-1',
    contactId: 'c-1',
    locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 139_000 },
    snippet: 'call me Thursday around four',
    explanation: 'She asked for a callback.',
    verified: true,
  };

  it('formats quote + locator like the architecture example', () => {
    expect(evidenceText(callRef)).toBe('“call me Thursday around four” at 2:14 in the call');
    expect(evidenceText({ sourceType: 'message', sourceId: 'm', snippet: 'pre-approved for 450' })).toBe('“pre-approved for 450” in the text');
    expect(evidenceText({ sourceType: 'ownership_period', sourceId: 'p', explanation: 'Accepted 3 h ago, no call or text since' })).toBe('Accepted 3 h ago, no call or text since');
    expect(evidenceText({ sourceType: 'message_status', sourceId: 'm', snippet: 'undelivered' })).toBe('“undelivered” in the message delivery status');
    expect(evidenceText({ sourceType: 'note', sourceId: 'n' })).toBe('From the note');
  });

  it('words evidence exactly like core/assistant formatEvidence for every source type and locator', () => {
    const locators: Locator[] = [
      { kind: 'transcript_offset', startMs: 134_000, endMs: 139_000 },
      { kind: 'transcript_offset', startMs: 3_725_000, endMs: 3_726_000 },
      { kind: 'transcript_offset', startMs: -5, endMs: 0 },
      { kind: 'message' },
      { kind: 'char_range', start: 3, end: 9 },
      { kind: 'field', name: 'price_range_max' },
    ];
    const snippets = ['call me Thursday around four', '  “Quoted, with edges!”  ', "'single'", '— dash —'];
    // 'home_valuation' is in the union only (core assistant/types.ts), but a home-value note's claim is worded too (R-AVM-1)
    for (const sourceType of [...SOURCE_TYPES, 'home_valuation'] as const)
      for (const locator of locators)
        for (const snippet of snippets) expect(formatEvidenceLine({ sourceType, locator, snippet })).toBe(formatEvidence({ sourceType, sourceId: 'x', locator, snippet }));
  });

  it('opens the source at the offset through the registry route of its surface', async () => {
    const routes = { call: (r: EvidenceRefView) => `/contacts/${r.contactId}/calls/${r.sourceId}?t=${r.locator?.kind === 'transcript_offset' ? Math.floor(r.locator.startMs / 1000) : 0}` };
    render(
      <MemoryRouter>
        <EvidenceRoutesProvider routes={routes}>
          <Routes>
            <Route path="/" element={<EvidenceLink evidence={callRef} />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </EvidenceRoutesProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('She asked for a callback.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: /call me Thursday around four/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/contacts/c-1/calls/call-1?t=134');
  });

  it('is plain text (no dead link) when no surface opens that source type', () => {
    render(
      <MemoryRouter>
        <EvidenceLink evidence={callRef} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('“call me Thursday around four” at 2:14 in the call')).toBeInTheDocument();
  });

  it('flags an unverified quote with "Check this" in words', () => {
    render(
      <MemoryRouter>
        <EvidenceLink evidence={{ ...callRef, verified: false }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Check this')).toBeInTheDocument();
    expect(screen.getByText(/wasn't found in the source/)).toBeInTheDocument();
  });
});

describe('ClaimLine', () => {
  it('shows the claim, its evidence, and a needs-review flag; never a score', () => {
    const claim = {
      text: 'Callback due Thu Nov 12, 4 PM',
      needsReview: true,
      confidence: 0.4,
      evidence: [{ sourceType: 'call', sourceId: 'call-1', locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 139_000 }, snippet: 'call me Thursday around four' }],
    } as unknown as Parameters<typeof ClaimLine>[0]['claim'];
    const { container } = render(
      <MemoryRouter>
        <ClaimLine claim={claim} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Callback due Thu Nov 12, 4 PM')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Evidence' })).getByText(/at 2:14 in the call/)).toBeInTheDocument();
    expect(screen.getByText('Check this')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-needs-review', 'true');
    expect(container.textContent).not.toMatch(/0\.4|40%|confidence/i);
  });

  it('says so when a claim has no source instead of hiding it', () => {
    render(
      <MemoryRouter>
        <ClaimLine claim={{ text: 'Prefers texts', needsReview: true, evidence: [] }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No source found for this.')).toBeInTheDocument();
  });
});

describe('Ratio', () => {
  it('always renders the denominator ("12 of 14 within SLA")', () => {
    const { container, rerender } = render(<Ratio value={12} of={14} label="within SLA" />);
    expect(container.textContent).toBe('12 of 14 within SLA');
    rerender(<Ratio value={0} of={0} label="appointments held" />);
    expect(container.textContent).toBe('0 of 0 appointments held');
    rerender(<Ratio value={Number.NaN} of={3.7} label="touched" />);
    expect(container.textContent).toBe('0 of 3 touched');
  });
});

describe('Button and TextField', () => {
  it('a pending button is busy, cannot be tapped twice, and keeps keyboard focus', async () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" onClick={onClick}>
          Send
        </Button>
      </form>,
    );
    screen.getByRole('button', { name: 'Send' }).focus();
    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit" pending pendingLabel="Sending" onClick={onClick}>
          Send
        </Button>
      </form>,
    );
    const b = screen.getByRole('button', { name: 'Sending' });
    // aria-disabled, not disabled: a disabled button would drop focus to <body> mid-action
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b).toHaveFocus();
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('every button and field meets the 44 px tap target token', () => {
    render(
      <>
        <Button>Go</Button>
        <TextField label="Email" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Go' }).className).toMatch(/\bmin-h-tap\b/);
    expect(screen.getByLabelText('Email').className).toMatch(/\bmin-h-tap\b/);
  });

  it('a field has a real label and its hint and error are announced with it', () => {
    render(<TextField label="Password" hint="At least 12 characters." error="Too short." />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('At least 12 characters. Too short.');
  });
});
