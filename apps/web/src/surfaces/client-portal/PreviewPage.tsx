// module 46 (R-PORTALWEB-10, R-PORTAL-16; E718): "What {name} sees". A staff page in the staff bundle: it reads 45's
// staff route GET /portal-grants/:id/preview (never the client API), parses it with the client's own parser and
// renders the client's own view components in preview mode (every control plain text), under a banner that says
// whether the client can see it now and, if not, 45's reasons. A 404 (another agent's grant, an ISA) is not-found.
import { useQuery } from '@tanstack/react-query';
import { useLocation, useParams } from 'react-router-dom';
import { Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, usePageTitle } from '../../shell/index.js';
import { GrantBody, PreviewBanner, type PreviewView, parsePreview } from '../../portal/view/index.js';
import { PORTAL_STAFF_MESSAGES, STAFF_WORDS } from './words.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PreviewPage() {
  const { grantId = '' } = useParams();
  const loc = useLocation();
  const given = (loc.state as { name?: unknown } | null)?.name;
  const name = typeof given === 'string' && given.trim() !== '' && given.length <= 120 ? given : null;
  usePageTitle(name ? STAFF_WORDS.sees(name) : null);
  const api = useApi();
  const valid = UUID.test(grantId);
  const q = useQuery<PreviewView, ApiError | Error>({
    queryKey: ['client-portal', 'preview', grantId],
    queryFn: async ({ signal }) => parsePreview(await api.get<unknown>(`/portal-grants/${grantId}/preview`, { signal })),
    enabled: valid,
    retry: false,
  });
  if (!valid || (q.isError && 'code' in q.error && q.error.code === 'NOT_FOUND')) return <Notice tone="info">{STAFF_WORDS.notFound}</Notice>;
  if (q.isPending) return <p className="text-[15px] text-ink-muted">{STAFF_WORDS.loading}</p>;
  if (q.isError) return <Notice tone="error">{'code' in q.error ? messageFor(q.error as ApiError, PORTAL_STAFF_MESSAGES) : messageFor('INTERNAL_ERROR')}</Notice>;
  const p = q.data;
  const who = name ?? STAFF_WORDS.theClient;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 md:mx-0">
      <PreviewBanner name={who} visibleNow={p.visibleNow} why={p.why} />
      <div className="rounded-2xl border border-dashed border-line p-3 md:p-4">
        <GrantBody grant={p.grant} timeline={p.timeline} documents={p.documents} mode="preview" layout="both" headingLevel={2} />
      </div>
    </div>
  );
}
