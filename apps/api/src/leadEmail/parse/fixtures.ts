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
