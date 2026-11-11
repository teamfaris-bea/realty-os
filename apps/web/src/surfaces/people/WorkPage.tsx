// Working a list (PARITY_PLAN §5): the person's page with a "Next person" bar (1 tap; J or → on a
// keyboard, K or ← for the previous one). The order is the list's, as the People page loaded it; when
// it runs out the next page is fetched with the list's own cursor. The person's page itself is the
// contact surface's (rendered here unchanged), so everything on it works as usual.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../design/index.js';
import { useApi } from '../../shell/index.js';
import { fetchPage } from './api.js';
import { extendWork, readWork, stepOf, type WorkList } from './workList.js';

const ContactPage = lazy(() => import('../contact/ContactPage.js'));

export default function WorkPage() {
  const { contactId = '' } = useParams();
  const nav = useNavigate();
  const api = useApi();
  const [work, setWork] = useState<WorkList | null>(() => readWork());
  const step = stepOf(work, contactId);
  const [loading, setLoading] = useState(false);

  const next = useCallback(async () => {
    if (step.next) return nav(`/people/work/${step.next}`);
    if (!work?.nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchPage(api, work.source, work.nextCursor);
      const w = extendWork(page.people.map((p) => p.id), page.nextCursor);
      setWork(w);
      const after = stepOf(w, contactId).next;
      if (after) nav(`/people/work/${after}`);
    } finally {
      setLoading(false);
    }
  }, [api, contactId, loading, nav, step.next, work]);
  const prev = useCallback(() => step.prev && nav(`/people/work/${step.prev}`), [nav, step.prev]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowRight') void next();
      if (e.key === 'k' || e.key === 'ArrowLeft') prev();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, prev]);

  const total = work ? work.ids.length : 0;
  const more = work?.nextCursor ? '+' : '';
  return (
    <div className="flex flex-col gap-3">
      {work && step.index >= 0 ? (
        <div role="region" aria-label="Working a list" className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-3 py-2">
          <p className="mr-auto text-[15px] text-ink-muted">
            {step.index + 1} of {total}
            {more} · Showing people you can see
          </p>
          <Button variant="secondary" onClick={prev} disabled={!step.prev} aria-keyshortcuts="K ArrowLeft">
            Previous
          </Button>
          <Button onClick={() => void next()} disabled={(!step.next && !work.nextCursor) || loading} aria-keyshortcuts="J ArrowRight">
            {loading ? 'Loading' : 'Next person'}
          </Button>
        </div>
      ) : null}
      <Suspense fallback={<p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>}>
        <ContactPage />
      </Suspense>
    </div>
  );
}
