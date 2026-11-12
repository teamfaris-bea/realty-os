// Fixtures of the lead-email parser tests. Every vendor fixture is SYNTHETIC: we have no real vendor
// samples. Addresses use the reserved .test TLD; phone numbers use the 555 range.
import type { ParseInput } from './types.js';

// SYNTHETIC — not a real vendor sample; VERIFY against a real email before launch
export const ZILLOW_TEXT = [
  'New buyer inquiry from Zillow',
  '',
  'Name: Jane Q. Buyer',
  'Email: Jane.Buyer@Example.test',
  'Phone: (555) 123-4567',
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
  <tr><td>Phone:</td><td>(555)&nbsp;123-4567</td></tr>
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
  'Phone: +1 555.987.6543',
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
<li>Phone: +1 555.987.6543</li>
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
  '- Phone: 555 222 3333',
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
<div>Name: Maria Garcia</div><div>Email: maria@example.test</div><div>Phone: 555 222 3333</div>
<div>Interested in: Renting</div><div>Address: 9 Elm Ct, Portland, OR 97201</div><div>Listing ID: ABC-123</div>
<div>Message: Looking for a 2 bedroom place.<br>Pets ok?</div>`;

// SYNTHETIC — a Zillow email whose template "changed" (E78): every label renamed
export const ZILLOW_CHANGED_TEXT = [
  'New buyer inquiry from Zillow',
  'Lead full name - Jane Q. Buyer',
  'Reach them at (555) 123-4567 or jane.buyer@example.test',
  'Home: 123 Maple Street',
].join('\n');

// SYNTHETIC — a newsletter-like email that is no lead at all
export const NEWSLETTER_TEXT = ['Market update for November', 'Prices rose 2% this month.', 'Contact us at hello@agency.test or (555) 444-5555.'].join('\n');

// ---- leadmetadata.org (R-LEM-10) -------------------------------------------------------------------------
// SYNTHETIC — our own samples of the leadmetadata.org convention (VERIFY 3: lead_phone, lead_message and
// lead_property_address names), not a portal's email.

// SYNTHETIC — declaration and values in the head
export const LEADMETA_HEAD_HTML = `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="lead_information_version" content="1.0">
<meta name="lead_name" content="Avery Sample">
<meta name="lead_email" content="Avery.Sample@Example.test">
<meta name="lead_phone" content="(555) 010-2030">
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
<meta name="lead_phone" content="555-010-4455&#x0A;Bcc: x@attacker.test">
<meta name="lead_unknown_field" content="ignored">
<p>Lead</p>
</body></html>`;

// ---- catalog portals without a vendor parser (R-LEM-9) -------------------------------------------------------
// SYNTHETIC — a generic-labelled lead email from each catalog portal's domain (no real samples: VERIFY)
export const CATALOG_PORTAL_DOMAINS = ['redfin.com', 'homes.com', 'homesnap.com', 'trulia.com', 'opcity.com'] as const;
export const catalogLabelled = (domain: string): ParseInput => ({
  subject: 'New lead',
  text: ['You have a new lead.', '', 'Name: Morgan Sample', 'Email: morgan.sample@example.test', 'Phone: 555-010-7788', '', `Questions? support@${domain}`].join('\n'),
  html: null,
  senderDomain: `mail.${domain}`,
});
export const catalogUnlabelled = (domain: string): ParseInput => ({
  subject: 'New lead',
  text: ['Morgan Sample is interested in 5 Birch Ln.', 'Reach them at morgan.sample@example.test or 555-010-7788.'].join('\n'),
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
  return [...note, ...header, 'New lead from Zillow', `Name: ${o.name ?? 'Sam Lead'}`, `Email: ${lead}`, `Phone: ${o.phone ?? '555-010-3344'}`, 'Message: Is it still available?'].join('\n');
};
