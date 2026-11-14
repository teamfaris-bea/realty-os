// module 46 (R-PORTALWEB-5, R-PORTALWEB-8, R-PORTALWEB-10; E689, E695, E698): the pure view components.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as F from '../test/fixtures.js';
import { ContactCard, GrantBody, PreviewBanner } from './components.js';
import { parseMe, parseTimeline } from './parse.js';
import { VIEW_WORDS } from './words.js';

const HOSTILE_TITLE = '<img src=x onerror="alert(1)"><b>bold</b>';
const URL_BODY = 'See https://evil.example.test/login and javascript:alert(1) and www.example.test';
const BIDI = '‮gnp.exe‬ Inspection';
const LONG = 'x'.repeat(5000);

function body(items: unknown[]) {
  return parseTimeline({ ...F.timeline(), items });
}

describe('view components (R-PORTALWEB-5)', () => {
  it('E689: HTML is text, URLs are not links, every server string is direction-isolated, and a 5,000-character word wraps', () => {
    // the parsers cap a body at 45's 4,000 characters; the component still wraps a longer word if one ever came
    const tl = body([{ ...F.timeline().items[0], title: HOSTILE_TITLE, body: URL_BODY }, { ...F.timeline().items[1], title: BIDI }]);
    tl.items[1] = { ...tl.items[1]!, body: LONG };
    const { container } = render(<GrantBody grant={parseMe(F.me()).grants[0]!} timeline={tl} documents={[]} mode="client" layout="both" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(HOSTILE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(URL_BODY)).toBeInTheDocument();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['sms:+15555550123', 'mailto:replies@example.test']);
    const bidi = screen.getByText(BIDI);
    expect(bidi).toHaveAttribute('dir', 'auto');
    const long = screen.getByText(LONG);
    expect(long.className).toContain('[overflow-wrap:anywhere]');
  });

  it('R-PORTALWEB-5: items keep the API order, each dated ("Shared …"), next steps "By …", no done mark, no grouping', () => {
    const tl = parseTimeline(F.timeline());
    render(<GrantBody grant={parseMe(F.me()).grants[0]!} timeline={tl} documents={[]} mode="client" layout="both" />);
    const titles = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(titles.findIndex((t) => t?.includes('Inspection'))).toBeLessThan(titles.findIndex((t) => t?.includes('Closing')));
    expect(screen.getByText('By Jan 10, 2027')).toBeInTheDocument();
    expect(screen.getAllByText(/^Shared [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toHaveLength(3);
    expect(screen.queryByText(/coming up|earlier|done|completed/i)).toBeNull();
  });

  it('empty states: no dates, no documents', () => {
    render(<GrantBody grant={parseMe(F.me()).grants[0]!} timeline={{ items: [], nextSteps: [] }} documents={[]} mode="client" layout="both" />);
    expect(screen.getByText(VIEW_WORDS.noDates)).toBeInTheDocument();
    expect(screen.getByText(VIEW_WORDS.noDocuments)).toBeInTheDocument();
  });

  it('R-PORTALWEB-8, E695: the card names the agent verbatim, never split; with no valid contact, the fallback sentence; no Call', () => {
    const { rerender } = render(<ContactCard contact={{ agentName: 'María José de la Cruz-Núñez', textTo: '+15555550123', emailTo: null }} mode="client" />);
    expect(screen.getByRole('link', { name: 'Text María José de la Cruz-Núñez' })).toBeInTheDocument();
    expect(screen.queryByText(/^María$/)).toBeNull();
    rerender(<ContactCard contact={{ agentName: 'Sam Agent', textTo: 'javascript:alert(1)', emailTo: 'a@example.test?cc=b@example.test' }} mode="client" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(VIEW_WORDS.contactFallback)).toBeInTheDocument();
    rerender(<ContactCard contact={null} mode="client" />);
    expect(screen.getByText(VIEW_WORDS.contactFallback)).toBeInTheDocument();
    expect(screen.queryByText(/call/i)).toBeNull();
  });

  it('R-PORTALWEB-10, E698: preview mode shows the controls as plain text (no link, no button, nothing focusable)', () => {
    const { container } = render(<GrantBody grant={parseMe(F.me()).grants[0]!} timeline={parseTimeline(F.timeline())} documents={F.documents().documents} mode="preview" layout="both" headingLevel={2} />);
    expect(container.querySelectorAll('a, button, input, [tabindex="0"]')).toHaveLength(0);
    expect(screen.getByText('Text Sam Agent')).toBeInTheDocument();
    expect(screen.getByText('Download Purchase contract.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('the preview banner: visible now, or each of 45\'s reasons (a generic one when none is given)', () => {
    const { rerender } = render(<PreviewBanner name="Jane Doe" visibleNow why={[]} />);
    expect(screen.getByText('This is what Jane Doe sees now.')).toBeInTheDocument();
    rerender(<PreviewBanner name="Jane Doe" visibleNow={false} why={['The client has not signed in yet.']} />);
    expect(screen.getByText("Jane Doe can't see this now: the client has not signed in yet.")).toBeInTheDocument();
    rerender(<PreviewBanner name="jane" visibleNow={false} why={[]} />);
    expect(screen.getByText("Jane can't see this now: " + VIEW_WORDS.previewGeneric)).toBeInTheDocument();
    expect(VIEW_WORDS.previewGeneric).toBe('the reason is not known.');
  });
});
