// Flyer PDFs (module 29; DocumentRenderer on pdf-lib, N16). GET /marketing-pieces/:id/flyer.pdf renders an approved
// flyer version against the LIVE listing (bound facts current, R-MKT-3; E90), with the identity block and the pack's
// statement at the prominence the template gave them, so what the guard checked (E92) is what the PDF shows. A draft
// is never rendered for download (R-MKT-1: nothing leaves the product unapproved).
import type { TenantId } from '@realty/core/foundation';
import { exportBundle, renderPiece } from '@realty/core/marketing';
import type { Tx } from '@realty/db';
import { getObject } from '../crypto/objects.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import type { DocumentRenderer, RenderedPdf } from '../providers/integrations/types.js';
import type { ObjectStorage } from '../providers/types.js';
import { assetObject } from './pieces.js';
import * as repo from './repo.js';

export async function flyerPdf(tx: Tx, d: { renderer: DocumentRenderer; envelope: EnvelopeService; storage: ObjectStorage; tenantId: string }, pieceId: string): Promise<RenderedPdf> {
  const p = await repo.pieceById(tx, pieceId);
  if (!p) throw new AppError('NOT_FOUND');
  if (p.kind !== 'flyer') throw new AppError('MARKETING_NOT_FLYER');
  if (!['approved', 'exported', 'published'].includes(p.status)) throw new AppError(p.status === 'draft' ? 'MARKETING_APPROVE_FIRST' : 'MARKETING_NOT_LIVE');
  const [assets, facts, identity] = await Promise.all([repo.assetsOf(tx, pieceId), repo.listingFacts(tx, p.listing_id), repo.identityOf(tx)]);
  if (!facts) throw new AppError('NOT_FOUND');
  const advertising = await repo.advertisingPacks(tx, identity.jurisdictions);
  const version = repo.versionOf(p, assets);
  const r = renderPiece(version, facts, identity, { advertising });
  const b = exportBundle(version, facts, identity, { advertising });
  if (!r.ok || !b.ok) throw new AppError('MARKETING_TEAM_LISTING_ONLY');
  const fields: Record<string, string> = {};
  r.blocks.forEach((blk, i) => {
    if (blk.text !== '') fields[`${String(i).padStart(2, '0')}:${blk.role}:${blk.prominence}`] = blk.text;
  });
  if (b.flags.includes('may_be_out_of_date')) fields['99:notice:small'] = 'May be out of date: the listing is no longer for sale.';
  const images: Uint8Array[] = [];
  for (const a of assets.slice(0, 4)) {
    const o = await assetObject(tx, pieceId, a.position);
    if (!o?.dek_wrapped) continue;
    const bytes = await getObject(d.envelope.inTx(tx, d.tenantId as TenantId), d.storage, d.tenantId as TenantId, o.id, o.storage_key, new Uint8Array(o.dek_wrapped));
    if (bytes) images.push(bytes);
  }
  return d.renderer.renderPdf({ templateKey: p.template_key, fields, imageCount: assets.length, images });
}
