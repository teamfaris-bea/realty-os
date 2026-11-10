// Object storage adapters. Both hold ciphertext only (crypto/objects.ts encrypts each blob with its
// per-object DEK before `put`). Keys must be `tenants/{tenant_id}/…` (R-TEN-9; the DB CHECK on
// stored_objects.storage_key enforces the same prefix) and may not escape the root.
//
// - MemoryStorage: tests and STORAGE_PROVIDER=fake.
// - LocalFsStorage: dev ("local encrypted FS"). An S3-compatible adapter for production needs a
//   bucket and credentials and is not built in Phase 1 (same interface).
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ObjectStorage } from './types.js';

const KEY_RE = /^tenants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/;

export class StorageKeyError extends Error {
  override readonly name = 'StorageKeyError';
}

/** Longest key accepted (the S3 object key limit). */
export const MAX_STORAGE_KEY_LENGTH = 1024;

export function assertStorageKey(key: string): void {
  if (key.length > MAX_STORAGE_KEY_LENGTH || !KEY_RE.test(key) || key.split('/').some((p) => p === '.' || p === '..')) {
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
  /**
   * The key's path, checked after resolving symlinks: the deepest existing directory on it must really
   * be inside the root (a symlinked directory under the root cannot redirect a write, a mkdir or a
   * read), and the object itself may not be a symlink.
   */
  private async realPath(key: string): Promise<string> {
    const p = this.path(key);
    let dir = dirname(p);
    let real: string | null = null;
    while (real === null) {
      try {
        real = await realpath(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        if (dir === this.root) return p; // nothing exists yet: nothing to follow
        dir = dirname(dir);
      }
    }
    const root = await realpath(this.root);
    if (real !== root && !real.startsWith(root + sep)) throw new StorageKeyError('storage key escapes the root');
    const st = await lstat(p).catch(() => null);
    if (st?.isSymbolicLink()) throw new StorageKeyError('storage object is a symlink');
    return p;
  }
  async put(key: string, bytes: Uint8Array, opts: { contentType: string }) {
    void opts; // content type lives in stored_objects; the file holds ciphertext only
    await mkdir(dirname(await this.realPath(key)), { recursive: true, mode: 0o700 });
    const p = await this.realPath(key);
    const tmp = `${p}.tmp-${process.pid}`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, p);
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(await this.realPath(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(key: string) {
    await rm(await this.realPath(key), { force: true });
  }
  async exists(key: string) {
    const p = await this.realPath(key); // a bad key throws StorageKeyError, never reads as "absent"
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }
}
