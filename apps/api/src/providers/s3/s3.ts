// S3-compatible ObjectStorage adapter (AWS S3, Cloudflare R2, MinIO) over global fetch with a
// hand-written SigV4 signer (./sigv4.ts). No SDK dependency.
//
// Holds CIPHERTEXT only: crypto/objects.ts encrypts each blob with its per-object DEK before `put`.
// Keys are validated with assertStorageKey (tenants/{uuid}/..., no traversal) in every method.
// Errors are ProviderError with a stable code and never carry keys, credentials or object bytes.
//
// Addressing: virtual-hosted style by default (https://{bucket}.{endpoint host}/{key}; the default
// endpoint is https://s3.{region}.amazonaws.com). `forcePathStyle` gives {endpoint}/{bucket}/{key},
// which MinIO and most custom endpoints (and R2's account endpoint) need.
import { createHash } from 'node:crypto';
import { assertStorageKey } from '../storage.js';
import { type ObjectStorage, ProviderError } from '../types.js';
import { EMPTY_SHA256_HEX, encodeRfc3986, signRequest } from './sigv4.js';

export interface S3StorageOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  serverSideEncryption?: 'AES256' | 'aws:kms' | null;
  kmsKeyId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const BACKOFF_MS = [50, 200] as const;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9_.!*'()-]+$/;

type Method = 'GET' | 'PUT' | 'DELETE' | 'HEAD';

class Retryable {
  constructor(readonly error: ProviderError) {}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function configError(): ProviderError {
  return new ProviderError('not_configured', 'S3_CONFIG_INVALID');
}

/** Best-effort read of the S3 XML <Code> (an AWS error code like NoSuchBucket; never the message). */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    const m = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(text);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export class S3Storage implements ObjectStorage {
  private readonly origin: URL;
  private readonly pathStyle: boolean;
  private readonly prefixSegments: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: S3StorageOptions) {
    if (!opts.region || !opts.accessKeyId || !opts.secretAccessKey || !BUCKET_RE.test(opts.bucket)) throw configError();
    if (opts.kmsKeyId !== undefined && opts.serverSideEncryption !== 'aws:kms') throw configError();
    let origin: URL;
    try {
      origin = new URL(opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`);
    } catch {
      throw configError();
    }
    if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.search || origin.hash || origin.username || origin.password) throw configError();
    this.origin = origin;
    this.pathStyle = opts.forcePathStyle ?? false;
    // virtual-hosted style needs the bucket to be a single DNS label
    if (!this.pathStyle && opts.bucket.includes('.')) throw configError();
    this.prefixSegments = (opts.prefix ?? '').split('/').filter((s) => s !== '');
    if (this.prefixSegments.some((s) => s === '.' || s === '..' || !PREFIX_SEGMENT_RE.test(s))) throw configError();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? (() => new Date());
  }

  /** The object URL for a validated key (exposed for tests and diagnostics; contains no secrets). */
  objectUrl(key: string): URL {
    assertStorageKey(key);
    const base = this.origin.pathname.replace(/\/+$/, '');
    const objectPath = [...this.prefixSegments, ...key.split('/')].map(encodeRfc3986).join('/');
    const url = new URL(this.origin.href);
    if (this.pathStyle) {
      url.pathname = `${base}/${encodeRfc3986(this.opts.bucket)}/${objectPath}`;
    } else {
      url.hostname = `${this.opts.bucket}.${this.origin.hostname}`;
      url.pathname = `${base}/${objectPath}`;
    }
    return url;
  }

  async put(key: string, bytes: Uint8Array, opts: { contentType: string }): Promise<void> {
    assertStorageKey(key);
    const headers: Record<string, string> = {
      'content-type': opts.contentType,
      'content-md5': createHash('md5').update(bytes).digest('base64'),
    };
    if (this.opts.serverSideEncryption) {
      headers['x-amz-server-side-encryption'] = this.opts.serverSideEncryption;
      if (this.opts.serverSideEncryption === 'aws:kms' && this.opts.kmsKeyId) headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.opts.kmsKeyId;
    }
    const payloadHash = createHash('sha256').update(bytes).digest('hex');
    await this.request('PUT', key, headers, bytes, payloadHash, async (res) => {
      if (res.status === 200 || res.status === 201 || res.status === 204) {
        await res.body?.cancel();
        return;
      }
      throw await this.failure(res);
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertStorageKey(key);
    return this.request('GET', key, {}, undefined, EMPTY_SHA256_HEX, async (res) => {
      if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 404) {
        if ((await errorCode(res)) === 'NoSuchBucket') throw new ProviderError('not_configured', 'S3_NO_SUCH_BUCKET');
        return null;
      }
      throw await this.failure(res);
    });
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.request('DELETE', key, {}, undefined, EMPTY_SHA256_HEX, async (res) => {
      if (res.status === 200 || res.status === 204 || res.status === 404) {
        await res.body?.cancel();
        return;
      }
      throw await this.failure(res);
    });
  }

  async exists(key: string): Promise<boolean> {
    assertStorageKey(key);
    return this.request('HEAD', key, {}, undefined, EMPTY_SHA256_HEX, async (res) => {
      await res.body?.cancel();
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw await this.failure(res);
    });
  }

  /** Maps a non-success response; throws Retryable for 5xx/429 so the loop can try again. */
  private async failure(res: Response): Promise<ProviderError> {
    const status = res.status;
    if (status === 429 || status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new Retryable(new ProviderError('unavailable', `S3_HTTP_${status}`));
    }
    await res.body?.cancel().catch(() => undefined);
    if (status === 403) return new ProviderError('not_configured', 'S3_FORBIDDEN');
    return new ProviderError('rejected', `S3_HTTP_${status}`);
  }

  /** All four operations are idempotent, so 5xx/429/network failures are retried (at most twice). */
  private async request<T>(method: Method, key: string, extra: Record<string, string>, body: Uint8Array | undefined, payloadHash: string, handle: (res: Response) => Promise<T>): Promise<T> {
    const url = this.objectUrl(key);
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      let lastError: ProviderError;
      try {
        const signed = signRequest({
          method,
          url,
          headers: extra,
          payloadSha256Hex: payloadHash,
          accessKeyId: this.opts.accessKeyId,
          secretAccessKey: this.opts.secretAccessKey,
          ...(this.opts.sessionToken ? { sessionToken: this.opts.sessionToken } : {}),
          region: this.opts.region,
          service: 's3',
          now: this.now(),
        });
        const res = await this.fetchImpl(url, {
          method,
          headers: { ...extra, ...signed },
          ...(body ? { body } : {}),
          redirect: 'manual',
          signal,
        });
        return await handle(res);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (e instanceof Retryable) lastError = e.error;
        else if (signal.aborted) throw new ProviderError('timeout', 'S3_TIMEOUT');
        else lastError = new ProviderError('unavailable', 'S3_NETWORK');
      }
      if (attempt >= MAX_RETRIES) throw lastError;
      await sleep(BACKOFF_MS[attempt] ?? 200);
    }
  }
}
