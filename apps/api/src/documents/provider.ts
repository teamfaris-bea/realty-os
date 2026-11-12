// The two adapters of module 42 (PHASE2_3_PLAN §5.4 #42; R-INT-1, R-DOC-7; dependencies N11 and N17).
//
// Both are PLATFORM configuration, never an integration_connections row (R-INT-1): no tenant connects a scanner, and
// neither adapter receives tenant context, a file name or anything but the bytes and their declared type and size.
// This build ships the interfaces, deterministic fakes for dev, staging and tests, and Unconfigured stand-ins that
// production gets without ALLOW_FAKE_PROVIDERS (providers/index.ts):
//   - no scanner: every upload stays pending and nobody, the Owner included, can open it (E402);
//   - no extractor: no contract dates are read; people enter them by hand (E418).
// A transient failure throws ProviderError; the caller retries and never treats an error as clean (E403).
//
// VERIFY with each vendor before a real adapter (N11 scanner, N17 PDF text reader): verdict vocabulary, how a
// password-protected or corrupt file is reported, size limits, data handling and retention on the vendor's side.
import { createHash } from 'node:crypto';
import { ProviderError } from '../providers/types.js';

export type ScanVerdict = { verdict: 'clean' } | { verdict: 'blocked'; reason: 'malware' | 'unscannable' };

export interface MalwareScanner {
  /** false in production until a scanner is procured (N11): uploads then stay pending */
  readonly configured: boolean;
  /** true for the deterministic fake: the UI says files are not really checked */
  readonly test: boolean;
  readonly statusText: string;
  /** recorded on the audit row of each verdict */
  readonly engine: string;
  scan(bytes: Uint8Array, hint: { contentType: string; byteSize: number }): Promise<ScanVerdict>;
}

export interface ExtractLimits {
  maxPages: 100;
  maxCharsPerPage: 20_000;
}
export const EXTRACT_LIMITS: ExtractLimits = { maxPages: 100, maxCharsPerPage: 20_000 };

export type ExtractResult = { status: 'text'; pages: { page: number; text: string }[] } | { status: 'no_text' } | { status: 'unreadable' };

export interface DocumentTextExtractor {
  /** false in production until a PDF text reader is procured (N17): nothing is extracted */
  readonly configured: boolean;
  readonly test: boolean;
  readonly statusText: string;
  readonly version: string;
  /** The PDF text layer only (no OCR, no model). */
  extract(pdf: Uint8Array, limits: ExtractLimits): Promise<ExtractResult>;
}

export const SCANNER_NOT_SET_UP = 'This platform has no virus scanner yet';
export const EXTRACTOR_NOT_SET_UP = 'Reading dates from PDFs is not set up on this platform';
export const SCANNER_TEST_TEXT = 'This deployment uses a test virus scanner: files are not really checked.';
export const EXTRACTOR_TEST_TEXT = 'This deployment uses a test PDF reader: dates are read only from test files.';

/** Production without ALLOW_FAKE_PROVIDERS: scans nothing (E402). */
export class UnconfiguredScanner implements MalwareScanner {
  readonly configured = false;
  readonly test = false;
  readonly statusText = SCANNER_NOT_SET_UP;
  readonly engine = 'none';
  async scan(): Promise<never> {
    throw new ProviderError('not_configured', 'SCANNER_NOT_CONFIGURED');
  }
}

/** Production without ALLOW_FAKE_PROVIDERS: reads nothing (E418). */
export class UnconfiguredTextExtractor implements DocumentTextExtractor {
  readonly configured = false;
  readonly test = false;
  readonly statusText = EXTRACTOR_NOT_SET_UP;
  readonly version = 'none';
  async extract(): Promise<never> {
    throw new ProviderError('not_configured', 'EXTRACTOR_NOT_CONFIGURED');
  }
}

// ---- deterministic fakes ------------------------------------------------------------------------------------

/** The EICAR test signature's distinctive part, assembled at runtime so no file in the repository carries it. */
export function eicarMarker(): string {
  return ['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-');
}
/** A fixture marker the fake scanner reports as unscannable (a password-protected file, say). */
export const FAKE_UNSCANNABLE_MARKER = 'REALTY-FAKE-UNSCANNABLE';

const contains = (bytes: Uint8Array, needle: string) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle, 0, 'latin1');

export class FakeScanner implements MalwareScanner {
  readonly configured = true;
  readonly test = true;
  readonly statusText = SCANNER_TEST_TEXT;
  readonly engine = 'fake-scanner/1';
  readonly calls: { contentType: string; byteSize: number }[] = [];
  /** test hook: the next N scans throw this (a transient failure) */
  failNext: { times: number; error: ProviderError } | null = null;

  async scan(bytes: Uint8Array, hint: { contentType: string; byteSize: number }): Promise<ScanVerdict> {
    this.calls.push({ contentType: hint.contentType, byteSize: hint.byteSize });
    if (this.failNext && this.failNext.times > 0) {
      this.failNext.times -= 1;
      throw this.failNext.error;
    }
    if (contains(bytes, eicarMarker())) return { verdict: 'blocked', reason: 'malware' };
    if (contains(bytes, FAKE_UNSCANNABLE_MARKER)) return { verdict: 'blocked', reason: 'unscannable' };
    return { verdict: 'clean' };
  }
}

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export class FakeTextExtractor implements DocumentTextExtractor {
  readonly configured = true;
  readonly test = true;
  readonly statusText = EXTRACTOR_TEST_TEXT;
  readonly version = 'fake-extractor/1';
  readonly calls: string[] = [];
  readonly #pages = new Map<string, ExtractResult>();
  failNext: { times: number; error: ProviderError } | null = null;

  /** Registers the text layer (or an outcome) of a test PDF, keyed by the sha256 of its bytes. */
  register(pdf: Uint8Array, result: ExtractResult | { page: number; text: string }[]): void {
    this.#pages.set(sha256Hex(pdf), Array.isArray(result) ? { status: 'text', pages: result } : result);
  }

  async extract(pdf: Uint8Array, limits: ExtractLimits): Promise<ExtractResult> {
    const k = sha256Hex(pdf);
    this.calls.push(k);
    if (this.failNext && this.failNext.times > 0) {
      this.failNext.times -= 1;
      throw this.failNext.error;
    }
    const r = this.#pages.get(k);
    if (!r) return { status: 'no_text' };
    if (r.status !== 'text') return r;
    return { status: 'text', pages: r.pages.slice(0, limits.maxPages).map((p) => ({ page: p.page, text: p.text.slice(0, limits.maxCharsPerPage) })) };
  }
}
