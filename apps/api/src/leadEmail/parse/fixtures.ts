// Fixtures of the lead-email parser tests. Every vendor fixture is SYNTHETIC: we have no real vendor
// samples. Addresses use the reserved .test TLD; phone numbers use the 555 range.
import type { ParseInput } from './types.js';

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const ZILLOW_TEXT = [
  'New buyer inquiry from Zillow',
  '',
  'Name: Jane Q. Buyer',
  'Email: Jane.Buyer@Example.test',
  'Phone: (555) 555-0127',
  'Property: 123 Maple Street, Springfield, IL 62704',
  'Zpid: 2081234567',
  'Message: Hi, I would like to see this home.',
  'I am free on weekends.',
  '',
  'You received this lead because you are a Premier Agent. Questions? leads@zillow.com',
  'Zillow, Inc. | notifications@mail.zillow.com',
].join('\n');

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const ZILLOW: ParseInput = { subject: 'New lead for 123 Maple Street', text: ZILLOW_TEXT, html: null, senderDomain: 'mail.zillow.com' };

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const ZILLOW_HTML = `<!doctype html><html><head><title>Zillow lead</title><style>.x { color: red } td > a { }</style></head>
<body>
<h1>New buyer inquiry from Zillow</h1>
<table>
  <tr><td>Name:</td><td>Jane Q. Buyer</td></tr>
  <tr><td>Email:</td><td><a href="mailto:jane.buyer@example.test">Jane.Buyer@Example.test</a></td></tr>
  <tr><td>Phone:</td><td>(555)&nbsp;555-0127</td></tr>
  <tr><td>Property:</td><td><a href="https://www.zillow.com/homedetails/2081234567_zpid/?utm=x">123 Maple Street, Springfield, IL 62704</a></td></tr>
  <tr><td>Zpid:</td><td>2081234567</td></tr>
</table>
<p>Message: Hi, I&#39;d like to see this home &amp; its yard.</p>
<script>var leak = "Email: evil@attacker.test";</script>
<!-- Email: comment@attacker.test -->
<div>Questions? <a href="mailto:leads@zillow.com">leads@zillow.com</a></div>
</body></html>`;

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const REALTOR_TEXT = [
  'You have a new lead from realtor.com',
  '',
  'Contact: John Doe',
  'Email: john.doe@example.test',
  'Phone: +1 555.555.0147',
  'Address: 456 Oak Ave, Austin, TX 78701-1234',
  'MLS #: TX-998877',
  'Comments: I want to sell my home this spring.',
  '',
  'realtor.com | Move, Inc. | Do not reply: noreply@move.com',
].join('\n');

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const REALTOR: ParseInput = { subject: 'New realtor.com lead', text: REALTOR_TEXT, html: null, senderDomain: 'leads.realtor.com' };

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const REALTOR_HTML = `<html><body>
<p>You have a new lead from <b>realtor.com</b></p>
<ul>
<li>Contact: John Doe</li>
<li>Email: john.doe@example.test</li>
<li>Phone: +1 555.555.0147</li>
<li>Address: 456 Oak Ave, Austin, TX 78701-1234</li>
<li>MLS #: TX-998877</li>
<li>Comments: I want to sell my home this spring.</li>
</ul>
<p>realtor.com</p>
</body></html>`;

// SYNTHETIC — our own generic labelled format (website forms / forwarding rules)
export const GENERIC_TEXT = [
  'New website inquiry',
  '- Name: Maria Garcia',
  '- Email: maria@example.test',
  '- Phone: 555 555 0129',
  '- Interested in: Renting',
  '- Address: 9 Elm Ct, Portland, OR 97201',
  '- Listing ID: ABC-123',
  '- Message:',
  '  Looking for a 2 bedroom place.',
  '  Pets ok?',
  '',
  'Sent from the site contact form.',
].join('\n');

// SYNTHETIC — our own generic labelled format
export const GENERIC: ParseInput = { subject: 'Website inquiry', text: GENERIC_TEXT, html: null, senderDomain: 'forms.agent-site.test' };

// SYNTHETIC — our own generic labelled format
export const GENERIC_HTML = `<div>New website inquiry</div>
<div>Name: Maria Garcia</div><div>Email: maria@example.test</div><div>Phone: 555 555 0129</div>
<div>Interested in: Renting</div><div>Address: 9 Elm Ct, Portland, OR 97201</div><div>Listing ID: ABC-123</div>
<div>Message: Looking for a 2 bedroom place.<br>Pets ok?</div>`;

// SYNTHETIC — a Zillow email whose template "changed" (E78): every label renamed
export const ZILLOW_CHANGED_TEXT = [
  'New buyer inquiry from Zillow',
  'Lead full name - Jane Q. Buyer',
  'Reach them at (555) 555-0127 or jane.buyer@example.test',
  'Home: 123 Maple Street',
].join('\n');

// SYNTHETIC — a newsletter-like email that is no lead at all
export const NEWSLETTER_TEXT = ['Market update for November', 'Prices rose 2% this month.', 'Contact us at hello@agency.test or (555) 555-0131.'].join('\n');

// ---- leadmetadata.org (R-LEM-10) -------------------------------------------------------------------------
// SYNTHETIC — our own samples of the leadmetadata.org convention (VERIFY 3: lead_phone, lead_message and
// lead_property_address names), not a portal's email.

// SYNTHETIC — declaration and values in the head
export const LEADMETA_HEAD_HTML = `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="lead_information_version" content="1.0">
<meta name="lead_name" content="Avery Sample">
<meta name="lead_email" content="Avery.Sample@Example.test">
<meta name="lead_phone" content="(555) 555-0120">
<meta name="lead_type" content="Buyer">
<meta name="lead_source" content="Some Other Portal">
<meta name='lead_property_address' content='5 Birch Ln, Fairview, OR 97024'>
<meta name="lead_message" content="I&#39;d like a tour &amp; the HOA fees.">
<title>New lead</title>
</head><body><p>You have a new lead. Open your dashboard to reply.</p></body></html>`;

// SYNTHETIC — the declaration and values in the body (some mail clients move head content)
export const LEADMETA_BODY_HTML = `<html><body>
<div>New inquiry</div>
<META NAME="lead_information_version" CONTENT="1.0">
<meta content="Robin Example" name="lead_name">
<meta name=lead_email content=robin@example.test>
<p>Reply from your dashboard.</p>
</body></html>`;

// SYNTHETIC — an unknown version: nothing is read
export const LEADMETA_UNKNOWN_VERSION_HTML = `<html><head>
<meta name="lead_information_version" content="2.0">
<meta name="lead_name" content="Casey Future">
<meta name="lead_email" content="casey@example.test">
</head><body>New lead</body></html>`;

// SYNTHETIC — escaped tags are text, not tags: nothing is read (the text shows them literally)
export const LEADMETA_ESCAPED_HTML = `<html><body>
<p>&lt;meta name="lead_information_version" content="1.0"&gt;</p>
<p>&lt;meta name="lead_email" content="escaped@example.test"&gt;</p>
</body></html>`;

// SYNTHETIC — a lead_email appearing twice with different values: held PARTIAL_FORMAT
export const LEADMETA_DUPLICATE_HTML = `<html><head>
<meta name="lead_information_version" content="1.0">
<meta name="lead_name" content="Drew Twice">
<meta name="lead_email" content="drew@example.test">
<meta name="lead_email" content="other@example.test">
</head><body>New lead</body></html>`;

// SYNTHETIC — hostile: every lead_* tag outside a real element (comments, script, style, textarea, title,
// attribute values, malformed names) must not be read; only the one real element is
export const LEADMETA_HOSTILE_HTML = `<html><head>
<title><meta name="lead_email" content="title@attacker.test"></title>
<meta name="lead_information_version" content="1.0">
<!-- <meta name="lead_email" content="comment@attacker.test"> -->
<script>document.write('<meta name="lead_email" content="script@attacker.test">')</script>
<style>/* <meta name="lead_email" content="style@attacker.test"> */</style>
<meta data-x='name="lead_email" content="attr@attacker.test"' name="lead_name" content="Quinn Real">
<metaname="lead_email" content="glued@attacker.test">
</head><body>
<textarea><meta name="lead_email" content="textarea@attacker.test"></textarea>
<meta name="lead_phone" content="555-555-0122&#x0A;Bcc: x@attacker.test">
<meta name="lead_unknown_field" content="ignored">
<p>Lead</p>
</body></html>`;

// ---- vendor shapes (SYNTHETIC; no real sample — VERIFY before launch) ----------------------------------------

export const ZILLOW_PREMIER_TEXT = [
  'New contact from Zillow Premier Agent',
  '',
  'Buyer name: Reese Sample',
  'Client email: Reese.Sample@Example.test',
  'Phone number: (555) 555-0160',
  'Property address: 80 Pine Rd, Reno, NV 89501',
  'Message: Can we tour this weekend?',
  '',
  'You received this because you are a Premier Agent. leads@zillow.com',
].join('\n');
export const ZILLOW_PREMIER: ParseInput = { subject: 'New Zillow contact', text: ZILLOW_PREMIER_TEXT, html: null, senderDomain: 'mail.zillow.com' };

export const REALTOR_MARKET_VIP_TEXT = [
  'You have a new Market VIP prospect from realtor.com',
  '',
  'Prospect name: Avery Prospect',
  'Prospect email: avery.prospect@example.test',
  'Prospect phone: (555) 555-0164',
  'Property of interest: 200 Market St, Austin, TX 78701',
  'Notes: Ready to tour homes in this area.',
  '',
  'realtor.com | Do not reply',
].join('\n');
export const REALTOR_MARKET_VIP: ParseInput = { subject: 'New Market VIP Prospect', text: REALTOR_MARKET_VIP_TEXT, html: null, senderDomain: 'email.realtor.com' };

export const OPCITY_TEXT = [
  'You have a new referral from Opcity',
  '',
  'Client name: Blair Referral',
  'Client email: blair.referral@example.test',
  'Client phone: (555) 555-0168',
  'Property address: 14 Lake Dr, Tampa, FL 33602',
  'Notes: Interested in buying this spring.',
  '',
  'Opcity | noreply@opcity.com',
].join('\n');
export const OPCITY: ParseInput = { subject: 'New Opcity referral', text: OPCITY_TEXT, html: null, senderDomain: 'mail.opcity.com' };

export const OPCITY_LOFTY_TEXT = [
  'New lead alert',
  '',
  'Source: Opcity',
  'Name: Casey Relay',
  'Email: casey.relay@example.test',
  'Phone: (555) 555-0172',
  'Property: 9 River Rd, Dallas, TX 75201',
  'Message: Please call about this referral.',
].join('\n');
export const OPCITY_LOFTY: ParseInput = { subject: 'New lead - Source Opcity', text: OPCITY_LOFTY_TEXT, html: null, senderDomain: 'alerts.lofty.com' };

export const HOMES_TEXT = [
  'New lead from Homes.com',
  '',
  'Lead name: Drew Homes',
  'Lead email: drew.homes@example.test',
  'Lead phone: (555) 555-0176',
  'Property address: 60 Oak St, Denver, CO 80202',
  'MLS number: CO-44021',
  'Comments: Is the backyard fenced?',
  '',
  'Homes.com | leads@homes.com',
].join('\n');
export const HOMES: ParseInput = { subject: 'New Homes.com lead', text: HOMES_TEXT, html: null, senderDomain: 'leads.homes.com' };

export const AGENTDASH_TEXT = [
  'AgentDash',
  'You have a new referral from Veterans United.',
  '',
  'Borrower name: Casey Sample',
  'Borrower email: casey.sample@example.test',
  'Borrower phone: (555) 555-0190',
  'Property address: 100 Oak St, Norfolk, VA 23510',
  'Loan type: VA',
  'Military status: Active duty',
  'Lender: Veterans United',
  'Message: Interested in buying near the base.',
  '',
  'Veterans United | agentupdates@vu.com',
].join('\n');
export const AGENTDASH: ParseInput = { subject: 'New referral from Veterans United', text: AGENTDASH_TEXT, html: null, senderDomain: 'vu.com' };

export const AGENTDASH_REREFERRAL_TEXT = [
  'AgentDash',
  'This borrower was re-referred by Veterans United.',
  '',
  'Borrower name: Casey Sample',
  'Borrower email: casey.sample@example.test',
  'Borrower phone: (555) 555-0190',
  'Property address: 100 Oak St, Norfolk, VA 23510',
  'Message: They want to sell my home too.',
  '',
  'Veterans United | agentupdates@vu.com',
].join('\n');
export const AGENTDASH_REREFERRAL: ParseInput = { subject: 'Updated referral from Veterans United', text: AGENTDASH_REREFERRAL_TEXT, html: null, senderDomain: 'vu.com' };

export const AGENTDASH_INVOICE_TEXT = [
  'Veterans United',
  'Invoice for closing documents',
  'Invoice #1001',
  'Amount due: $0.00',
  'This is not a new referral. Closing documents are attached.',
  'Questions? Call (555) 555-0199 or billing@vu.com',
].join('\n');
export const AGENTDASH_INVOICE: ParseInput = { subject: 'Invoice for closing documents', text: AGENTDASH_INVOICE_TEXT, html: null, senderDomain: 'vu.com' };

export const IDX_TEXT = [
  'New inquiry from your IDX site',
  '',
  'Your name: Indy Sample',
  'Your email: indy.sample@example.test',
  'Your phone: 555-555-0171',
  'MLS number: IDX-4401',
  'Property address: 4 Cedar Ave, Boise, ID 83702',
  'Your message: Is this still available?',
  'Interested in: Buying',
].join('\n');
export const IDX: ParseInput = { subject: 'New IDX inquiry', text: IDX_TEXT, html: null, senderDomain: 'forms.idx-site.test' };

export const FALLBACK_PROSE = [
  'Hi, this is Quinn Sample.',
  'I would like information on 15 Spruce St, Bend, OR 97701.',
  'You can reach me at quinn.sample@example.test or (555) 555-0188.',
  'Thanks',
].join('\n');
export const FALLBACK: ParseInput = { subject: 'Question about a listing', text: FALLBACK_PROSE, html: null, senderDomain: 'leads.idx-broker.test' };

// ---- catalog portals without a vendor parser (R-LEM-9) -------------------------------------------------------
// SYNTHETIC — a generic-labelled lead email from each catalog portal's domain (no real samples: VERIFY)
export const CATALOG_PORTAL_DOMAINS = ['redfin.com', 'homes.com', 'homesnap.com', 'trulia.com', 'opcity.com'] as const;
export const catalogLabelled = (domain: string): ParseInput => ({
  subject: 'New lead',
  text: ['You have a new lead.', '', 'Name: Morgan Sample', 'Email: morgan.sample@example.test', 'Phone: 555-555-0124', '', `Questions? support@${domain}`].join('\n'),
  html: null,
  senderDomain: `mail.${domain}`,
});
export const catalogUnlabelled = (domain: string): ParseInput => ({
  subject: 'New lead',
  text: ['Morgan Sample is interested in 5 Birch Ln.', 'Reach them at morgan.sample@example.test or 555-555-0124.'].join('\n'),
  html: null,
  senderDomain: `mail.${domain}`,
});

// ---- hand forwards (R-LEM-11) ---------------------------------------------------------------------------
// SYNTHETIC — a lead forwarded by hand from a personal mailbox; the forwarder's own note sits above the marker.
// The consumer-domain addresses contain '_' and '-', which Gmail does not allow in an account name: they can never
// be a real person's mailbox.
export const SYNTHETIC_LEAD_GMAIL = 'synthetic_lead-sam@gmail.com';
export const SYNTHETIC_FORWARDER_GMAIL = 'synthetic_forwarder-agent@gmail.com';
export const forwardedByHand = (marker: 'gmail' | 'outlook' | 'apple', o: { lead?: string; forwarder?: string; phone?: string; name?: string } = {}): string => {
  const lead = o.lead ?? SYNTHETIC_LEAD_GMAIL;
  const forwarder = o.forwarder ?? SYNTHETIC_FORWARDER_GMAIL;
  const note = ['FYI see below', 'Name: Not The Lead', `Email: ${forwarder}`, ''];
  const header =
    marker === 'gmail'
      ? ['---------- Forwarded message ---------', 'From: Zillow <leads@zillow.com>', 'Date: Mon, Nov 9, 2026 at 9:00 AM', 'Subject: New lead', `To: <${forwarder}>`, '']
      : marker === 'outlook'
        ? ['________________________________', 'From: Zillow <leads@zillow.com>', 'Sent: Monday, November 9, 2026 9:00 AM', `To: ${forwarder}`, 'Subject: New lead', '']
        : ['Begin forwarded message:', '', 'From: Zillow <leads@zillow.com>', 'Subject: New lead', `To: ${forwarder}`, ''];
  return [...note, ...header, 'New lead from Zillow', `Name: ${o.name ?? 'Sam Lead'}`, `Email: ${lead}`, `Phone: ${o.phone ?? '555-555-0121'}`, 'Message: Is it still available?'].join('\n');
};
