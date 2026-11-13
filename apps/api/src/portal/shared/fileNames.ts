// Download file names for the client portal (R-PORTAL-17). Pure. The same names module 42's staff download gives
// (documents/read.ts downloadNames; fileNames.test.ts proves equality on a corpus), always as an attachment, and safe
// in a header: the ASCII form drops control characters, quotes, backslashes, % and ;, the UTF-8 form is
// percent-encoded (RFC 5987), so no display name can inject a header or a second parameter.
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function portalFileNames(displayName: string, contentType: string): { asciiName: string; utf8Name: string } {
  const ext = EXT[contentType] ?? 'bin';
  const hasExt = new RegExp(`\\.${ext}$`, 'i').test(displayName) || (ext === 'jpg' && /\.jpeg$/i.test(displayName));
  const full = hasExt ? displayName : `${displayName}.${ext}`;
  const ascii = full.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%;]/g, '_').trim();
  return { asciiName: ascii === '' || ascii === `.${ext}` ? `document.${ext}` : ascii, utf8Name: encodeURIComponent(full) };
}

export function attachmentDisposition(displayName: string, contentType: string): string {
  const n = portalFileNames(displayName, contentType);
  return `attachment; filename="${n.asciiName}"; filename*=UTF-8''${n.utf8Name}`;
}
