// R-TEN-9 storage keys (ObjectStorage): only `tenants/{uuid}/…` keys, never a path that could leave
// the tenant prefix or the adapter's root, in every adapter (memory and the local encrypted FS).
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFsStorage, MemoryStorage, StorageKeyError, assertStorageKey } from './storage.js';

const T = '01a1c4ba-0000-7000-8000-0000000000aa';
const OK = `tenants/${T}/import_file/01a1c4ba-0000-7000-8000-0000000000d1`;

const BAD_KEYS: [string, string][] = [
  ['empty', ''],
  ['no tenant prefix', `import_file/${T}`],
  ['foreign prefix', `other/${T}/x`],
  ['tenant id not a uuid', 'tenants/acme/x'],
  ['uppercase uuid (not the canonical form)', `tenants/${T.toUpperCase()}/x`],
  ['tenant dir only', `tenants/${T}`],
  ['tenant dir with slash', `tenants/${T}/`],
  ['absolute path', `/tenants/${T}/x`],
  ['absolute elsewhere', '/etc/passwd'],
  ['parent traversal', `tenants/${T}/../${T.replace('aa', 'bb')}/x`],
  ['parent traversal at the end', `tenants/${T}/x/..`],
  ['dot segment', `tenants/${T}/./x`],
  ['traversal before the tenant', 'tenants/../../etc/passwd'],
  ['backslash', `tenants/${T}/..\\..\\x`],
  ['backslash separator', `tenants\\${T}\\x`],
  ['NUL byte', `tenants/${T}/x\u0000.txt`],
  ['URL-encoded traversal', `tenants/${T}/%2e%2e/%2e%2e/x`],
  ['URL-encoded slash', `tenants/${T}/..%2fx`],
  ['double-encoded traversal', `tenants/${T}/%252e%252e/x`],
  ['empty segment', `tenants/${T}//x`],
  ['trailing slash', `tenants/${T}/x/`],
  ['newline', `tenants/${T}/x\n`],
  ['unicode dot lookalike', `tenants/${T}/․․/x`],
  ['fullwidth solidus', `tenants/${T}/x／y`],
  ['space', `tenants/${T}/a b`],
  ['URL scheme', `file:///tenants/${T}/x`],
  ['overlong key', `tenants/${T}/${'a'.repeat(1100)}`],
];

describe('assertStorageKey', () => {
  it('R-TEN-9: accepts tenants/{uuid}/… keys made of safe segments', () => {
    for (const k of [OK, `tenants/${T}/recording/2025/abc_DEF-1.mp3`, `tenants/${T}/x...y`]) expect(() => assertStorageKey(k)).not.toThrow();
  });

  it('R-TEN-9: refuses every key that is not tenants/{uuid}/… or could traverse (.., absolute, backslash, NUL, URL-encoded, lookalikes, overlong)', () => {
    for (const [why, k] of BAD_KEYS) {
      let out = 'accepted';
      try {
        assertStorageKey(k);
      } catch (e) {
        out = e instanceof StorageKeyError ? 'refused' : String(e);
      }
      expect([why, out]).toEqual([why, 'refused']);
    }
  });
});

describe('adapters enforce the key rule on every operation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'realty-storage-keys-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('MemoryStorage and LocalFsStorage refuse bad keys for put, get, exists and delete, and write nothing', async () => {
    const root = join(dir, 'root');
    for (const s of [new MemoryStorage(), new LocalFsStorage(root)]) {
      for (const [why, k] of BAD_KEYS) {
        for (const op of [() => s.put(k, new Uint8Array([1]), { contentType: 'x' }), () => s.get(k), () => s.delete(k), () => s.exists(k)]) {
          await expect(op(), `${s.constructor.name}: ${why}`).rejects.toBeInstanceOf(StorageKeyError);
        }
      }
    }
    expect(readdirSync(dir)).toEqual([]); // the FS adapter did not even create its root
  });

  it('LocalFsStorage keeps every path inside its root, even when a directory under the root is a symlink that points outside', async () => {
    const root = join(dir, 'fs');
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(root, 'tenants'), { recursive: true });
    symlinkSync(outside, join(root, 'tenants', T)); // planted: tenants/{T} → outside the root
    const s = new LocalFsStorage(root);
    await expect(s.put(OK, new Uint8Array([1, 2]), { contentType: 'x' })).rejects.toBeInstanceOf(StorageKeyError);
    await expect(s.get(OK)).rejects.toBeInstanceOf(StorageKeyError);
    expect(readdirSync(outside)).toEqual([]);
  });
});
