// Link a campaign to a listing and that listing's approved or published marketing piece (module 55 item 10; PATCH
// /ads/campaigns/:id {listingId, creativePieceId}, ads.campaign_manage: Owner/Admin). Only the two ids are sent; the
// campaign becomes managed on the next hourly check if Google Ads reports it qualifies, which the page says.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Dialog, Notice, announce } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { useAction } from '../admin/lib/hooks.js';
import { SelectField } from '../admin/lib/ui.js';
import type { ListingView } from '../feed/lib/types.js';
import { kindLabel } from '../marketing/lib.js';
import type { ListingMarketingView } from '../marketing/types.js';
import { ADS_KEY, type CampaignResponse, type CampaignView } from './types.js';
import { refusalWords } from './words.js';

export function LinkCampaign({ campaign }: { campaign: CampaignView }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {campaign.listingId ? 'Change listing' : 'Link to a listing'}
      </Button>
      {open ? <LinkDialog campaign={campaign} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function LinkDialog({ campaign, onClose }: { campaign: CampaignView; onClose(): void }) {
  const api = useApi();
  const [listingId, setListingId] = useState(campaign.listingId ?? '');
  const [pieceId, setPieceId] = useState(campaign.creativePieceId ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const listings = useQuery<{ listings: ListingView[] }, ApiError>({
    queryKey: ['ads', 'link', 'listings'],
    queryFn: ({ signal }) => api.get('/listings?limit=200', { signal }),
  });
  const marketing = useQuery<ListingMarketingView, ApiError>({
    queryKey: ['ads', 'link', 'marketing', listingId],
    queryFn: ({ signal }) => api.get(`/listings/${listingId}/marketing`, { signal }),
    enabled: listingId !== '',
  });
  const pieces = (marketing.data?.pieces ?? []).filter((p) => p.status === 'approved' || p.status === 'published');
  const save = useAction<{ listingId: string; creativePieceId: string }, CampaignResponse>('PATCH', { invalidate: [ADS_KEY] });

  const doSave = async () => {
    if (!listingId || !pieceId) return;
    setProblem(null);
    const r = await save.run(`/ads/campaigns/${campaign.id}`, { listingId, creativePieceId: pieceId });
    if (r.ok) {
      announce('Linked. The campaign is managed here once Google Ads reports it qualifies at the next hourly check.');
      onClose();
    } else setProblem(refusalWords(r));
  };

  return (
    <Dialog
      title="Link to a listing"
      description="Pick the listing this campaign advertises and its approved marketing piece. It is managed here once Google Ads reports it qualifies at the next hourly check."
      onClose={onClose}
      footer={
        <div className="flex flex-wrap gap-2">
          <Button pending={save.pending} pendingLabel="Saving" disabled={!listingId || !pieceId} onClick={() => void doSave()}>
            Save link
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <SelectField label="Listing" value={listingId} onChange={(e) => { setListingId(e.target.value); setPieceId(''); }}>
          <option value="">{listings.isPending ? 'Loading listings' : 'Choose a listing'}</option>
          {(listings.data?.listings ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {`${l.addressLine1}, ${l.city}`}
            </option>
          ))}
        </SelectField>
        {listingId ? (
          <SelectField label="Approved marketing piece" value={pieceId} onChange={(e) => setPieceId(e.target.value)} hint={marketing.isSuccess && pieces.length === 0 ? 'This listing has no approved or published marketing piece yet.' : undefined}>
            <option value="">{marketing.isPending ? 'Loading pieces' : 'Choose a piece'}</option>
            {pieces.map((p) => (
              <option key={p.id} value={p.id}>
                {`${kindLabel(p.kind)} · version ${p.versionNo} · ${p.statusLabel}`}
              </option>
            ))}
          </SelectField>
        ) : null}
        {listings.isError ? <Notice tone="error">The listings did not load. Close this and try again.</Notice> : null}
        {problem ? <Notice tone="error">{problem}</Notice> : null}
      </div>
    </Dialog>
  );
}
