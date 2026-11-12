// The sentences module 55 shows for documents, verbatim (PHASE2_3_PLAN §5.4 #42). Honest copy: what is true now,
// never a claim the product does not make. The API returns them so the web never paraphrases a state.
export { EXTRACTOR_NOT_SET_UP, EXTRACTOR_TEST_TEXT, SCANNER_NOT_SET_UP, SCANNER_TEST_TEXT } from './provider.js';

// VERIFY WITH COUNSEL: the copy "Blocked by the virus check" (blockedMalware, blockedHeld, blockedReasonUnknown), and
// whether a held malicious file must be kept and blocked uploads are records (E405, blockedHeld).
export const COPY = {
  checking: 'Checking this file for viruses. Only you and the Owner or Admin can see it until the check passes.',
  noScanner: 'This platform has no virus scanner yet, so the file stays locked. Nobody can open it until a scanner checks it.',
  blockedMalware: 'Blocked by the virus check. The file was deleted; nobody can open it.',
  blockedUnscannable: 'The virus check could not read this file (it may be password-protected), so it was blocked. Upload a copy without a password.',
  blockedHeld: 'Blocked by the virus check. The file is kept locked because of a legal hold.',
  /** Q5 for a viewer who cannot read the verdict (only Owners and Admins read the document.scanned audit row) */
  blockedReasonUnknown:
    "Blocked by the virus check: it found a threat, or it could not read the file (a password-protected file can't be checked). The file was deleted; nobody can open it. If the file has a password, upload a copy without one.",
  photo: 'Photos and scans are not read. Enter the dates by hand.',
  relativeDeadline: 'Deadlines written as a number of days are not read here; plan them from the acceptance date.',
  needsReview: 'Not found in the document as quoted: enter this date by hand if it is right.',
  sharedNotCleared: 'Marked for the client portal. Clients see nothing until the portal is turned on.',
  unshared: "Downloads stop now. The client's portal still lists it until it is retracted there.",
  /** E159, verbatim R-DOC-2 */
  noText: 'No text found in this PDF; enter the dates by hand',
  noDates: 'No dates found next to the labels we read. Enter the dates by hand.',
  unreadable: 'This PDF could not be read. Enter the dates by hand.',
  extractionExplanation: 'Dates found in this contract. Confirm each one; nothing is added to the timeline until you do.',
  movedByPerson: "Moved by a person from the contract's date.",
  /** E412: the contract states two or more different dates of one kind; the claims sit side by side, none preselected */
  conflictingDates: 'This contract states more than one date for this. Check which applies before you confirm one.',
} as const;

/** E409: a new version of a shared document; the previous one stays shared until a person changes it. */
export function previousVersionSharedText(versionNo: number): string {
  return `Version ${versionNo - 1} is still shared to the client portal. When this version passes the virus check, share it and stop sharing version ${versionNo - 1}.`;
}
