// The strict response schema of GET /api/contacts/:id/homeowner (module 78; R-HOME-4, R-HOME-8). It mirrors core
// homeownerView exactly: every object is strict (an unknown key fails the response), and there is no score,
// confidence, percentage, estimate, balance, equity or owner-name field anywhere.
import { z } from 'zod';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Link = z.strictObject({ label: z.string().max(120), url: z.url({ protocol: /^https$/ }) });
const Reason = z.enum(['seller_intent', 'seller_inquiry', 'homeowner_tag', 'past_buyer']);
const Field = z.enum([
  'last_transfer_date', 'last_transfer_price_cents', 'county_market_value_cents', 'assessed_value_cents', 'annual_tax_cents',
  'tax_year', 'exemption_legal_residence', 'exemption_homestead', 'owner_mailing_address', 'mls_sale_history', 'in_house_value',
]);
const Why = z.enum(['not_in_record', 'not_kept', 'not_checked', 'links_only', 'pending_d9']);

const Row = z.discriminatedUnion('state', [
  z.strictObject({ key: Field, state: z.literal('value'), value: z.union([z.string().max(300), z.number().int().nonnegative(), z.boolean()]), source: z.string().max(80), asOf: Day.nullable(), readOn: Day.nullable() }),
  z.strictObject({ key: Field, state: z.literal('not_available'), why: Why, link: Link.nullable() }),
  z.strictObject({ key: Field, state: z.literal('not_kept'), why: Why, link: Link.nullable() }),
  z.strictObject({ key: Field, state: z.literal('pending_d9'), why: z.literal('pending_d9') }),
]);

const Check = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('checked'), checkedOn: Day, nextCheckOn: Day }),
  z.strictObject({ state: z.literal('not_checked') }),
  z.strictObject({ state: z.literal('not_configured'), text: z.string().max(200) }),
  z.strictObject({ state: z.literal('failed'), failedOn: Day, lastReadOn: Day.nullable() }),
  z.strictObject({ state: z.literal('links_only') }),
  z.strictObject({ state: z.literal('outside_area') }),
]);

const Home = z.strictObject({
  address: z.string().max(400),
  county: z.strictObject({ key: z.enum(['sc-beaufort', 'sc-jasper']), name: z.string().max(60), mode: z.enum(['connector', 'links', 'shared']) }).nullable(),
  check: Check,
  outcome: z.enum(['matched', 'not_matched', 'not_available', 'ambiguous', 'failed', 'pending', 'links_only', 'outside_area']),
  matchDetail: z.enum(['address_mismatch', 'owner_name_mismatch', 'missing_data']).nullable(),
  rows: z.array(Row).max(20),
  yearsOwned: z.strictObject({ years: z.number().int().nonnegative(), since: Day, basis: z.enum(['county_transfer', 'team_closing']), source: z.string().max(80), asOf: Day.nullable() }).nullable(),
  mailingDiffers: z.boolean().nullable(),
  lookupLinks: z.array(Link).max(4),
  loansLink: Link.nullable(),
  providerNote: z.string().max(200).nullable(),
});

export const HomeownerResponse = z.strictObject({
  recognized: z.boolean(),
  reasons: z.array(z.strictObject({ reason: Reason, since: Day.nullable() })).max(4),
  homes: z.array(Home).max(20),
  outreach: z.strictObject({ built: z.literal(false), clearanceOn: Day.nullable() }),
});
export type HomeownerResponseT = z.infer<typeof HomeownerResponse>;
