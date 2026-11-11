// The bulk confirm-sheet slot (PARITY_PLAN §4.1: module 61 renders module 64's sheets). The People bulk bar
// opens module 64's BulkActionSheet with the current selection: the checked people (ids), or after "Select
// all" the whole list (a saved smart list, or the unsaved definition of a tag chip view), which the server
// resolves and freezes at draft (module 60's resolveSelection: detail-visible people only, the kind's cap,
// never a protected-tag audience for a send or a plan). The sheet shows who is included, who is left out and
// why, and only Confirm starts the one audited bulk_actions record (R-PAR-33).
import { BulkActionSheet } from '../bulk/index.js';
import type { Definition } from './api.js';

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
  /** the tags the list was built from (protected first): hand-picked people from it are still that audience (R-PAR-8) */
  audienceTagIds?: string[];
}

export interface BulkSheetProps {
  request: BulkRequest;
  onClose: () => void;
  /** the action was confirmed (it runs in the background; the sheet stays open with its progress link) */
  onDone: (summary: string) => void;
}

export const BULK_LABEL: Record<BulkKind, string> = { tag: 'Tag', untag: 'Remove tag', stage: 'Change stage', assign: 'Assign', enroll: 'Start plan', email: 'Email', text: 'Text' };

export function BulkConfirmSheet({ request, onClose, onDone }: BulkSheetProps) {
  const n = request.count.toLocaleString('en-US');
  const who = `${request.countCapped ? `${n}+` : n} ${request.count === 1 && !request.countCapped ? 'person' : 'people'}`;
  const ids = 'contactIds' in request.selection ? request.selection.contactIds : null;
  const what = request.tag ? `${BULK_LABEL[request.kind]} "${request.tag.name}"` : undefined;
  return (
    <BulkActionSheet
      kind={request.kind}
      {...(ids ? { contactIds: ids } : { selection: request.selection as { listId: string } | { definition: Definition } })}
      selectedText={who}
      {...(request.audienceTagIds?.length ? { audienceTagIds: request.audienceTagIds } : {})}
      {...(request.tag ? { params: { tagId: request.tag.id } } : {})}
      {...(what ? { paramLabel: what } : {})}
      onClose={onClose}
      onConfirmed={(a) => onDone(`${what ?? BULK_LABEL[request.kind]}: started for ${a.targetCount} ${a.targetCount === 1 ? 'person' : 'people'}`)}
    />
  );
}
