// The bulk confirm-sheet slot (PARITY_PLAN §4.1: module 61 renders module 64's sheets). The People bulk bar
// opens module 64's BulkActionSheet with the current selection: the checked people (ids), or after "Select
// all" the whole list (a saved smart list, or the unsaved definition of a tag chip view), which the server
// resolves and freezes at draft (module 60's resolveSelection: detail-visible people only, the kind's cap,
// never a protected-tag audience for a send or a plan). People checked one by one carry the list they were
// picked from (audienceSource), so the server reads that list's tags itself (R-PAR-8). The sheet shows who
// is included, who is left out and why, and only Confirm starts the one audited bulk_actions record
// (R-PAR-33). A send or a plan from a list the rows already said is protected is refused here at once, as
// the server would: nothing is asked of it.
import { Button, Dialog, Notice } from '../../design/index.js';
import { BulkActionSheet } from '../bulk/index.js';
import type { Definition } from './api.js';
import { LISTS_ERROR_MESSAGES } from './messages.js';

export type BulkKind = 'tag' | 'untag' | 'stage' | 'assign' | 'enroll' | 'email' | 'text';

export interface BulkRequest {
  kind: BulkKind;
  /** resolveSelection's input (PARITY_PLAN §4.2) */
  selection: { contactIds: string[] } | { listId: string } | { definition: Definition };
  /** people in the selection, as the list shows them (the bulk draft re-counts and freezes) */
  count: number;
  countCapped: boolean;
  /** tag / untag: the chosen tag */
  tag?: { id: string; name: string; protected: boolean };
  /** the list references a protected tag (R-PAR-8): sends and enrollments are refused */
  audienceProtected: boolean;
  /** the list the checked people were picked from: they are still its audience, and the server reads its tags (R-PAR-8) */
  audienceSource?: { listId: string } | { definition: Definition };
}

export interface BulkSheetProps {
  request: BulkRequest;
  onClose: () => void;
  /** the action was confirmed (it runs in the background; the sheet stays open with its progress link) */
  onDone: (summary: string) => void;
}

export const BULK_LABEL: Record<BulkKind, string> = { tag: 'Tag', untag: 'Remove tag', stage: 'Change stage', assign: 'Assign', enroll: 'Start plan', email: 'Email', text: 'Text' };

/** R-PAR-8: the kinds a protected-tag list can never be the audience of. */
const AUDIENCE_KINDS: ReadonlySet<BulkKind> = new Set(['email', 'text', 'enroll']);

export function BulkConfirmSheet({ request, onClose, onDone }: BulkSheetProps) {
  const n = request.count.toLocaleString('en-US');
  const who = `${request.countCapped ? `${n}+` : n} ${request.count === 1 && !request.countCapped ? 'person' : 'people'}`;
  if (request.audienceProtected && AUDIENCE_KINDS.has(request.kind)) {
    return (
      <Dialog title={`${BULK_LABEL[request.kind]} ${who}`} onClose={onClose} footer={<div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>}>
        <Notice tone="warn">{LISTS_ERROR_MESSAGES['AUDIENCE_PROTECTED_PROXY']}</Notice>
      </Dialog>
    );
  }
  const ids = 'contactIds' in request.selection ? request.selection.contactIds : null;
  const what = request.tag ? `${BULK_LABEL[request.kind]} "${request.tag.name}"` : undefined;
  return (
    <BulkActionSheet
      kind={request.kind}
      {...(ids ? { contactIds: ids } : { selection: request.selection as { listId: string } | { definition: Definition } })}
      selectedText={who}
      {...(ids && request.audienceSource ? { audienceSource: request.audienceSource } : {})}
      {...(request.tag ? { params: { tagId: request.tag.id } } : {})}
      {...(what ? { paramLabel: what } : {})}
      onClose={onClose}
      onConfirmed={(a) => onDone(`${what ?? BULK_LABEL[request.kind]}: started for ${a.targetCount} ${a.targetCount === 1 ? 'person' : 'people'}`)}
    />
  );
}
