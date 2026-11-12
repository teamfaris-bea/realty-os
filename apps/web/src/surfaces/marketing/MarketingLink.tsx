// The listing page's way into its marketing tab (one line in surfaces/listings/ListingsPages.tsx).
import { ButtonLink } from '../../design/index.js';

export function MarketingLink({ listingId }: { listingId: string }) {
  return (
    <ButtonLink to={`/listings/${listingId}/marketing`} variant="secondary" className="self-start">
      Marketing
    </ButtonLink>
  );
}
