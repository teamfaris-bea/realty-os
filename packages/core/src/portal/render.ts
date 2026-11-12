// renderPortalItem(source): the one deterministic plain-text copy of a source, used for both module
// 46's staff preview and the published row. It reads only the per-kind allowlist below, never the
// publisher or the grant, and its output always passes the portal_items CHECKs.
//
// Field allowlist (VERIFY WITH COUNSEL, C10):
//   milestone      title: label, else the milestone kind's name          occursOn: due_on
//   document       title: display_name; body: the document kind and version   documentId = sourceId
//   showing        title: the showing's status in words                  occursOn: starts_at's local date
//   feedback       title: "Showing feedback" and the rating; body: comments, verbatim   occursOn: received_at's local date
//   seller_update  title: "Seller update"; body: the approved text, verbatim
//   next_step      title: the task title                                 occursOn: due_at's local date
// Never: task notes, buyer-agent names or brokerages, contact data, assignees, ids other than the
// source's. Dates are slots: the date lives only in occursOn; titles and bodies carry no rendered date.
import { localDateOf, type IanaZone, type Instant, type LocalDate } from '../foundation/index.js';
import type { MilestoneKind } from '../transactions/index.js';
import { cleanTitle, verbatimBody } from './text.js';
import type { DocumentKind, DocumentId, PortalItemSpec, PortalKind, SourceFacts } from './types.js';
import { isSourceFacts } from './validate.js';

const MILESTONE_NAMES: Readonly<Record<MilestoneKind, string>> = {
  acceptance: 'Offer accepted', inspection: 'Inspection', appraisal: 'Appraisal', financing: 'Financing',
  closing: 'Closing', possession: 'Possession', custom: 'Milestone',
};
const DOCUMENT_KIND_NAMES: Readonly<Record<DocumentKind, string>> = {
  purchase_contract: 'Purchase contract', addendum: 'Addendum', disclosure: 'Disclosure', inspection: 'Inspection report',
  appraisal: 'Appraisal', listing_agreement: 'Listing agreement', other: 'Document',
};
const SHOWING_TITLES = { scheduled: 'Showing scheduled', completed: 'Showing', canceled: 'Showing canceled', no_show: 'Showing did not take place' } as const;

const dateIn = (t: Instant | null, z: IanaZone): LocalDate | null => (t === null ? null : localDateOf(t, z));

export function renderPortalItem(source: SourceFacts): PortalItemSpec {
  if (!isSourceFacts(source as unknown)) throw new RangeError('renderPortalItem: not a well-formed SourceFacts');
  const s = source.source;
  const z = source.zone;
  const item = (kind: PortalKind, title: string, body: string | null, occursOn: LocalDate | null, sourceVersion = 1, documentId: DocumentId | null = null): PortalItemSpec => ({
    kind, title, body, occursOn, documentId, sourceType: s.type, sourceId: s.type === 'showing' ? s.showing.id : s.type === 'showing_feedback' ? s.feedback.id : s.id, sourceVersion,
  });
  switch (s.type) {
    case 'deal_date':
      return item('milestone', cleanTitle(s.label ?? '', MILESTONE_NAMES[s.kind]), null, s.dueOn, s.dueVersion);
    case 'document':
      return item('document', cleanTitle(s.displayName, 'Document'), `${DOCUMENT_KIND_NAMES[s.kind]}, version ${s.versionNo}`, null, s.versionNo, s.id);
    case 'showing':
      return item('showing', SHOWING_TITLES[s.showing.status], null, dateIn(s.showing.startsAt, z));
    case 'showing_feedback': {
      const f = s.feedback;
      return item('feedback', f.rating === null ? 'Showing feedback' : `Showing feedback: rated ${f.rating} of 5`, f.comments === null ? null : verbatimBody(f.comments), dateIn(f.receivedAt, z));
    }
    case 'assistant_action':
      return item('seller_update', 'Seller update', verbatimBody(s.text), null);
    case 'task':
      return item('next_step', cleanTitle(s.title, 'Next step'), null, dateIn(s.dueAt, z));
  }
}
