// module 46: the client's view, the only part of src/portal staff code may import (R-PORTALWEB-1, R-PORTALWEB-10).
// Pure components, parsers, dates, contact guards and words: no window, document, fetch, location or history.
export { ContactCard, Documents, GrantBody, GrantHeader, NextSteps, PreviewBanner, Timeline, Txt, type DocumentsProps, type GrantBodyProps, type GrantLayout, type GrantTab, type ViewMode } from './components.js';
export { mailtoHref, smsHref } from './contact.js';
export { formatLocalDate, formatShared } from './dates.js';
export {
  ITEM_KINDS,
  ParseError,
  isLocalDate,
  parseDocument,
  parseDocuments,
  parseGrant,
  parseItem,
  parseLoginAccepted,
  parseMe,
  parsePreview,
  parseSession,
  parseStreamToken,
  parseTimeline,
  type ContactView,
  type DocumentView,
  type DocumentsView,
  type GrantView,
  type ItemKind,
  type ItemView,
  type MeView,
  type PreviewView,
  type SessionView,
  type StreamTokenView,
  type TimelineView,
} from './parse.js';
export { VIEW_WORDS, byDate, downloadLabel, emailAgent, previewHidden, previewVisible, sharedOn, textAgent, visibleUntil } from './words.js';
