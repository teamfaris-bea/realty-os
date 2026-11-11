// The bulk confirm-sheet slot (PARITY_PLAN §4.1: module 61 renders module 64's sheets). Module 64
// (web/templates-bulk, lane L3) replaces `BulkConfirmSheet` with its real sheets (frozen target,
// preview, skips by reason, Confirm) by changing the one import below. Until it merges, the stub says
// plainly that bulk actions are not available yet: nothing is ever done half-way or one by one,
// because every bulk action must be one audited bulk_actions record (R-PAR-33).
import { Button, Dialog, Notice } from '../../design/index.js';
import type { Definition } from './api.js';

export type BulkKind = 'tag' | 'untag' | 'stage' | 'assign' | 'enroll' | 'email' | 'text';

export interface BulkRequest {
  kind: BulkKind;
  /** resolveSelection's input (PARITY_PLAN §4.2) */
  selection: { contactIds: string[] } | { listId: string } | { definition: Definition };
  /** people in the selection, as the list shows them (the bulk preview re-counts and freezes) */
  count: number;
  countCapped: boolean;
  /** tag / untag: the chosen tag */
  tag?: { id: string; name: string; protected: boolean };
  /** the list references a protected tag (R-PAR-8): sends and enrollments are refused */
  audienceProtected: boolean;
}

export interface BulkSheetProps {
  request: BulkRequest;
  onClose: () => void;
  onDone: (summary: string) => void;
}

export const BULK_LABEL: Record<BulkKind, string> = { tag: 'Tag', untag: 'Remove tag', stage: 'Change stage', assign: 'Assign', enroll: 'Start plan', email: 'Email', text: 'Text' };

/** STUB until module 64 merges (lane L3): the honest "not yet" sheet. */
export function BulkConfirmSheet({ request, onClose }: BulkSheetProps) {
  const who = `${request.countCapped ? `${request.count.toLocaleString('en-US')}+` : request.count.toLocaleString('en-US')} ${request.count === 1 ? 'person' : 'people'}`;
  const what = request.tag ? `${BULK_LABEL[request.kind]} "${request.tag.name}"` : BULK_LABEL[request.kind];
  const sends = request.kind === 'email' || request.kind === 'text' || request.kind === 'enroll';
  return (
    <Dialog title={`${what} · ${who}`} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {sends && request.audienceProtected ? (
        <Notice tone="warn">This list uses a protected tag, so it cannot be the audience of a bulk email, text or plan.</Notice>
      ) : request.tag?.protected && request.kind === 'tag' ? (
        <Notice tone="warn">"{request.tag.name}" is a protected tag. It is added one person at a time, never in bulk.</Notice>
      ) : (
        <Notice tone="info" title="Bulk actions are coming with the templates and bulk update">
          Nothing was changed. When bulk actions arrive, this sheet shows exactly who is included, who is skipped and why, before you confirm.
        </Notice>
      )}
    </Dialog>
  );
}
