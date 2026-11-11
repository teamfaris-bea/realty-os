-- Marketing (module 29 api/marketing, M29; PHASE2_3_PLAN §5.4 #29; DATA_MODEL R-MKT-7, R-MKT-9; E91;
-- ARCHITECTURE §21.13 security notes).
--
-- No table shape and no RLS policy changes (PHASE2_3_PLAN §4 migration policy): marketing_pieces,
-- marketing_piece_assets (0018) and marketing_publications (0025) already exist. This migration adds one function:
--
--   app.public_listing_page(text, text)   SECURITY REVIEW ITEM: pre-tenant definer; a public listing page by
--                                         (tenant slug, page slug) -> the approved prose, the bound facts of the team
--                                         listing, the identity block and the ordered asset ids of the piece, or only
--                                         'gone' with a notice (retracted page, off-market listing: the API answers
--                                         410). Never contact data.
--
-- Public listing-page viewers are not principals (ARCHITECTURE §21.1): this definer is the only way an anonymous page
-- request reads anything. Image bytes are served by the API after the same definer named the object as an asset of
-- the live page, as the system actor of the tenant the definer returned (stored_objects policy
-- objects_marketing_assets), never by an id the request chose alone.

-- -----------------------------------------------------------------------------
-- 1. The public page (SECURITY REVIEW ITEM)
-- -----------------------------------------------------------------------------
-- Input: the tenant's slug and the page's public_slug (both shape-checked here as well as in the API).
-- Output: at most one row.
--   state 'live':  the website_page piece that holds this slug is 'published', its listing is a team listing that is not
--                  sold/withdrawn/expired, the tenant is active and platform:fair_housing is cleared (R-INT-6: a later
--                  unreviewed pack version takes every page down again). Returns the tenant id (the API reads the
--                  piece's images as that tenant's system actor), the piece id, version, prose, template, bound
--                  fields, the listing's bound facts (no listing agent, no contact, no private attribute), the
--                  brokerage identity block, the tenant's jurisdictions (for the advertising packs) and the asset
--                  object ids in position order (through marketing_piece_assets only, R-MKT-7).
--   state 'gone':  the page was retracted, or its listing went off market (R-MKT-9, E91): only the notice; every other
--                  column NULL (no tenant id, no prose). The API answers 410.
--   no row:        unknown tenant or slug, an inactive tenant, a draft/approved/superseded version (a superseded version
--                  gave its slug to the newer one), an MLS listing, or the pack not cleared. The API answers 404.
-- Owned by app_definer (BYPASSRLS), pinned search_path, STABLE, writes nothing.
CREATE FUNCTION app.public_listing_page(p_tenant_slug text, p_page_slug text)
RETURNS TABLE (state text, notice text, tenant_id uuid, piece_id uuid, version_no integer, prose jsonb, template_key text,
               bound_fields text[], listing_status text, address_line1 text, address_line2 text, city text, region text,
               postal_code text, list_price_cents bigint, beds smallint, baths_x10 smallint, sqft integer,
               property_type text, brokerage_legal_name text, team_name text, brokerage_license_number text,
               brokerage_postal_address text, operating_jurisdictions text[], asset_object_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH p AS (
    SELECT mp.tenant_id, mp.id, mp.version_no, mp.status, mp.prose, mp.template_key, mp.bound_fields,
           l.status AS listing_status, l.address_line1, l.address_line2, l.city, l.region, l.postal_code,
           l.list_price_cents, l.beds, l.baths_x10, l.sqft, l.property_type,
           s.brokerage_legal_name, s.team_name, s.brokerage_license_number, s.brokerage_postal_address,
           s.operating_jurisdictions
      FROM public.tenants t
      JOIN public.marketing_pieces mp ON mp.tenant_id = t.id AND mp.kind = 'website_page' AND mp.public_slug = p_page_slug
      JOIN public.listings l ON l.tenant_id = mp.tenant_id AND l.id = mp.listing_id AND l.source = 'team'
      JOIN public.tenant_settings s ON s.tenant_id = t.id
     WHERE p_tenant_slug ~ '^[a-z0-9][a-z0-9-]{1,40}$' AND p_page_slug ~ '^[a-z0-9][a-z0-9-]{2,80}$'
       AND t.slug = p_tenant_slug::citext AND t.status = 'active'
       AND mp.status IN ('published','retracted')
  )
  SELECT 'gone', CASE WHEN p.status = 'retracted' THEN 'This page was taken down.'
                      WHEN p.listing_status = 'sold' THEN 'This home has sold.'
                      ELSE 'This home is no longer for sale.' END,
         NULL::uuid, NULL::uuid, NULL::integer, NULL::jsonb, NULL::text, NULL::text[], NULL::text, NULL::text, NULL::text,
         NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::smallint, NULL::smallint, NULL::integer, NULL::text,
         NULL::text, NULL::text, NULL::text, NULL::text, NULL::text[], NULL::uuid[]
    FROM p WHERE p.status = 'retracted' OR p.listing_status IN ('sold','withdrawn','expired')
  UNION ALL
  SELECT 'live', NULL, p.tenant_id, p.id, p.version_no, p.prose, p.template_key, p.bound_fields, p.listing_status,
         p.address_line1, p.address_line2, p.city, p.region, p.postal_code, p.list_price_cents, p.beds, p.baths_x10,
         p.sqft, p.property_type, p.brokerage_legal_name, p.team_name, p.brokerage_license_number,
         p.brokerage_postal_address, p.operating_jurisdictions,
         COALESCE((SELECT array_agg(a.object_id ORDER BY a.position) FROM public.marketing_piece_assets a
                    JOIN public.stored_objects o ON o.tenant_id = a.tenant_id AND o.id = a.object_id
                                                AND o.purpose = 'marketing_asset' AND o.deleted_at IS NULL
                   WHERE a.tenant_id = p.tenant_id AND a.piece_id = p.id), '{}'::uuid[])
    FROM p WHERE p.status = 'published' AND p.listing_status NOT IN ('sold','withdrawn','expired')
     AND app.platform_cleared('platform:fair_housing')
$$;
ALTER FUNCTION app.public_listing_page(text, text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.public_listing_page(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.public_listing_page(text, text) TO app_user;

-- the definer reads these (app_definer bypasses RLS but still needs table privileges)
GRANT SELECT ON tenants, tenant_settings, listings, marketing_pieces, marketing_piece_assets, stored_objects, jurisdiction_packs TO app_definer;
