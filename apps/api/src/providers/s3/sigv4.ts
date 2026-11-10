// AWS Signature Version 4 for S3-compatible object storage (AWS S3, Cloudflare R2, MinIO).
// Pure: no clock, no I/O. The caller passes `now` and the hex sha256 of the payload, and adds the
// returned headers to the request. Every header passed in `headers` is signed, plus `host` (from
// the URL unless given) and the x-amz-* headers this function adds.
//
// Reference: AWS "Authenticating Requests: Using the Authorization Header (AWS Signature Version 4)",
// S3 flavour: the canonical URI is the URI-encoded path, each segment encoded once (RFC 3986
// unreserved characters kept, '/' kept), and never normalized.
import { createHash, createHmac } from 'node:crypto';

export const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SignRequestInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadSha256Hex: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: 's3';
  now: Date;
}

export interface SignedHeaders {
  authorization: string;
  'x-amz-date': string;
  'x-amz-content-sha256': string;
  'x-amz-security-token'?: string;
}

/** RFC 3986 percent-encoding: everything except A-Z a-z 0-9 - . _ ~ is encoded (UTF-8 bytes). */
export function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg; // a stray '%' that is not an escape: treat the segment as raw text
  }
}

/** S3 canonical URI: decode each segment once (URL keeps escapes), re-encode per RFC 3986. */
export function canonicalUri(url: URL): string {
  const path = url.pathname === '' ? '/' : url.pathname;
  return path
    .split('/')
    .map((seg) => encodeRfc3986(decodeSegment(seg)))
    .join('/');
}

export function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

const normalizeValue = (v: string) => v.trim().replace(/\s+/g, ' ');

export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');

export interface CanonicalParts {
  canonicalRequest: string;
  signedHeaders: string;
  stringToSign: string;
  signature: string;
}

/** Exposed for tests: the full derivation for a set of already-complete headers. */
export function computeSignature(input: { method: string; url: URL; headers: Record<string, string>; payloadSha256Hex: string; secretAccessKey: string; region: string; service: string; amzDate: string }): CanonicalParts {
  const merged = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers)) {
    const n = name.toLowerCase().trim();
    const prev = merged.get(n);
    merged.set(n, prev === undefined ? normalizeValue(value) : `${prev},${normalizeValue(value)}`);
  }
  const names = [...merged.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${merged.get(n) ?? ''}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri(input.url), canonicalQuery(input.url), canonicalHeaders, signedHeaders, input.payloadSha256Hex].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return { canonicalRequest, signedHeaders, stringToSign, signature };
}

export function signRequest(input: SignRequestInput): SignedHeaders {
  const date = amzDate(input.now);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    const n = k.toLowerCase();
    // the signer owns these; a stale caller value must not be signed alongside ours
    if (n === 'authorization' || n === 'x-amz-date' || n === 'x-amz-content-sha256' || n === 'x-amz-security-token') continue;
    headers[n] = v;
  }
  if (headers.host === undefined) headers.host = input.url.host;
  headers['x-amz-date'] = date;
  headers['x-amz-content-sha256'] = input.payloadSha256Hex;
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;
  const { signedHeaders, signature } = computeSignature({ ...input, headers, amzDate: date });
  const day = date.slice(0, 8);
  const out: SignedHeaders = {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${day}/${input.region}/${input.service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': date,
    'x-amz-content-sha256': input.payloadSha256Hex,
  };
  if (input.sessionToken) out['x-amz-security-token'] = input.sessionToken;
  return out;
}
