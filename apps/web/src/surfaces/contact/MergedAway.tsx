// A record merged into another (R-OWN-24): the person lives on the record it was merged into. Nothing is offered here
// that the API refuses (CONTACT_MERGED: a text, an email, a call or an enrollment of a merged-away record), and the page
// says where the person went (batch 6 review ui-compose/F7). `to` is contacts.merged_into_contact_id: the record it was
// merged into, whose own page says the same if that one was merged too.
import { Link } from 'react-router-dom';
import { Notice } from '../../design/index.js';

export function MergedAwayNotice({ to }: { to: string }) {
  return (
    <Notice tone="info">
      This record was merged into another contact. Call, text and email them on their current record.{' '}
      <Link to={`/contacts/${to}`} className="font-medium text-accent underline">
        Open the current record
      </Link>
    </Notice>
  );
}
