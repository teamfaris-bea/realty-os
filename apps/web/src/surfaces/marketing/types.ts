// View types for module 38's marketing tab, following api/marketing/routes.ts (PieceSchema and friends).
// Only the fields the web reads are typed; the server is the authority for every label shown.

export type PieceKind = 'website_page' | 'social_post' | 'open_house_invite' | 'flyer' | 'marketplace_export';
export type PieceStatus = 'draft' | 'approved' | 'published' | 'exported' | 'retracted' | 'superseded';

export interface PublicationView {
  id: string;
  connectionId: string;
  targetKind: string;
  targetName: string;
  status: 'publishing' | 'published' | 'failed' | 'unknown' | 'retracted';
  /** the server's provider-confirmed flag: the ONLY thing that lets the UI say "Posted" */
  posted: boolean;
  /** the server's honest words for this publication, shown verbatim */
  label: string;
  requestedAt?: string;
  publishedAt?: string | null;
}

export type PublishOption =
  | {
      kind: 'publish';
      connectionId: string;
      target: 'facebook_page' | 'instagram_business';
      displayName: string;
    }
  | {
      kind: 'export';
      connectionId: string | null;
      reason: string;
      sentence: string;
    };

export interface PreviewBlock {
  role: string;
  origin: string;
  prominence: string;
  text: string;
}

export interface PieceView {
  id: string;
  listingId: string;
  kind: PieceKind;
  versionNo: number;
  status: PieceStatus;
  statusLabel: string;
  prose: Record<string, unknown>;
  contentSha256: string;
  openHouse?: { startsAt: string; endsAt: string; zone: string } | null;
  timezone: string;
  preview: { text: string; blocks: PreviewBlock[] } | null;
  assets: { position: number; objectId: string; url: string }[];
  guard: {
    approvable: boolean;
    reasons: string[];
    checkThis: boolean;
    soft: string[];
  };
  publicPath: string | null;
  publications: PublicationView[];
  publishOptions: PublishOption[];
  earlierPostNotice: string | null;
  exportable: boolean;
  invitable: boolean;
}

export interface ListingMarketingView {
  pieces: PieceView[];
  targets: { id: string; kind: string; status: string; displayName: string }[];
  publishingCleared: boolean;
  fairHousingReviewSentence: string;
}

export interface ExportView {
  text: string;
  label: string;
  flags: string[];
  images: { position: number; url: string }[];
  flyerUrl: string | null;
}
