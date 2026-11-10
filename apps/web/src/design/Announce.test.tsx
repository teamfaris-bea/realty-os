// Polite announcements for toasts and live countdowns (WCAG 4.1.3).
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Announcer, announce, countdownMilestone, milestoneWords, useCountdownAnnouncement } from './index.js';

describe('announcements', () => {
  it('announce() speaks through one polite, atomic live region without moving focus', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    render(<Announcer />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    act(() => announce('Accepted. Priya Shah is yours.'));
    await act(async () => vi.advanceTimersToNextFrame());
    expect(region).toHaveTextContent('Accepted. Priya Shah is yours.');
    vi.useRealTimers();
  });

  it('a countdown reaches a milestone only at 5, 2 and 1 min, 30 s, 10 s and the end', () => {
    expect(countdownMilestone(299_001 + 60_000)).toBeNull();
    expect(countdownMilestone(300_000)).toBe(300);
    expect(countdownMilestone(200_000)).toBe(300);
    expect(countdownMilestone(120_000)).toBe(120);
    expect(countdownMilestone(59_500)).toBe(60);
    expect(countdownMilestone(29_000)).toBe(30);
    expect(countdownMilestone(9_000)).toBe(10);
    expect(countdownMilestone(0)).toBe(0);
    expect(countdownMilestone(-5_000)).toBe(0);
    expect([300, 120, 60, 30, 0].map(milestoneWords)).toEqual(['5 minutes left', '2 minutes left', '1 minute left', '30 seconds left', 'Time is up']);
  });

  it('a ticking countdown is announced at milestones, not every second', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    render(<Announcer />);
    const region = screen.getByRole('status');
    const spoken: string[] = [];
    const { rerender } = renderHook(({ ms }) => useCountdownAnnouncement('Offer for Priya Shah', ms), { initialProps: { ms: 200_000 } });
    for (let ms = 199_000; ms >= 0; ms -= 1000) {
      rerender({ ms });
      await act(async () => vi.advanceTimersToNextFrame());
      if (region.textContent && spoken.at(-1) !== region.textContent) spoken.push(region.textContent);
    }
    expect(spoken).toEqual([
      'Offer for Priya Shah: 2 minutes left',
      'Offer for Priya Shah: 1 minute left',
      'Offer for Priya Shah: 30 seconds left',
      'Offer for Priya Shah: 10 seconds left',
      'Offer for Priya Shah: Time is up',
    ]);
    vi.useRealTimers();
  });
});
