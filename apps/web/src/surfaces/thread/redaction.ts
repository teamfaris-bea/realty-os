// b18 Q-PORTAL-16 (R-PORTAL-20): the label of a message, or of one of its MMS text parts, whose quoted sign-in link
// token is not shown. Its own module so the thread row (ThreadPage.tsx) and the attachments under it (Attachments.tsx,
// b18 review F4) say the same words without importing each other.

/**
 * Honest about what was kept: a 'stored' record was saved without the token (so the history is not the exact original);
 * a 'display' one is an older record whose stored copy still has it, hidden on this screen only.
 */
export const REDACTION_NOTE: Record<'stored' | 'display', string> = {
  stored: 'A sign-in link in this message was not kept: its token was removed before the message was saved, so this is not the exact original.',
  display: 'A sign-in link in this message is hidden here.',
};

/**
 * b18 review B18S-2: the same label for the person page's latest inquiry (lead_inquiries.content_redacted, 0097): the
 * intake stores what the person typed (a web-chat opening message, a lead form's message) without the token value.
 */
export const INQUIRY_REDACTION_NOTE: Record<'stored' | 'display', string> = {
  stored: 'A sign-in link in this inquiry was not kept: its token was removed before the inquiry was saved, so this is not the exact original.',
  display: 'A sign-in link in this inquiry is hidden here.',
};
