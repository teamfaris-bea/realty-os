// Object storage adapters. Both hold ciphertext only (crypto/objects.ts encrypts each blob with its
// per-object DEK before `put`). Keys must be `tenants/{tenant_id}/…` (R-TEN-9; the DB CHECK on
// stored_objects.storage_key enforces the same prefix) and may not escape the root.
//
// - MemoryStorage: tests and STORAGE_PROVIDER=fake.
// - LocalFsStorage: dev ("local encrypted FS"). An S3-compatible adapter for production needs a
//   bucket and credentials and is not built in Phase 1 (same interface).
import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ObjectStorage } from './types.js';

const KEY_RE = /^tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/;

export class StorageKeyError extends Error {
  override readonly name = 'StorageKeyError';
}

export function assertStorageKey(key: string): void {
  if (!KEY_RE.test(key) || key.split('/').some((p) => p === '.' || p === '..')) {
    throw new StorageKeyError('storage key must be tenants/{tenant_id}/... without traversal');
  }
}

export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, opts: { contentType: string }) {
    assertStorageKey(key);
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: opts.contentType });
  }
  async get(key: string) {
    assertStorageKey(key);
    const o = this.objects.get(key);
    return o ? new Uint8Array(o.bytes) : null;
  }
  async delete(key: string) {
    assertStorageKey(key);
    this.objects.delete(key);
  }
  async exists(key: string) {
    assertStorageKey(key);
    return this.objects.has(key);
  }
}

export class LocalFsStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    assertStorageKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new StorageKeyError('storage key escapes the root');
    return p;
  }
  async put(key: string, bytes: Uint8Array, opts: { contentType: string }) {
    void opts; // content type lives in stored_objects; the file holds ciphertext only
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${process.pid}`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, p);
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}
