// A record merged into another (R-OWN-24): the person lives on the record it was merged into. Nothing is offered here
// that the API refuses (CONTACT_MERGED: a text, an email, a call or an enrollment of a merged-away record), and the page
// says where the person went (batch 6 review ui-compose/F7). `to` is the API's mergedIntoContactId: the record the
// person lives on now (the end of the merge chain), or null when this viewer may not open it (R-PERM-5: a collaborator
// of the merged-away record is not told about the survivor), so there is no link that would answer "not found".
import { Link } from 'react-router-dom';
import { Notice } from '../../design/index.js';

/** The record is merged away: the API's `merged`, or (an API older than it) a named survivor. */
export function isMergedAway(contact: { merged?: boolean; mergedIntoContactId: string | null }): boolean {
  return contact.merged === true || contact.mergedIntoContactId !== null;
}

export function MergedAwayNotice({ to }: { to: string | null }) {
  if (to === null) return <Notice tone="info">This record was merged into another contact you can't open. Ask its owner or an Admin.</Notice>;
  return (
    <Notice tone="info">
      This record was merged into another contact. Call, text and email them on their current record.{' '}
      <Link to={`/contacts/${to}`} className="font-medium text-accent underline">
        Open the current record
      </Link>
    </Notice>
  );
}
