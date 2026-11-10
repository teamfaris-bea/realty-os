// XSS guard for URLs rendered from data into href/src (docs/SECURITY.md, web lane).
import { describe, expect, it } from 'vitest';
import { safeUrl } from './safeUrl.js';

describe('safeUrl', () => {
  it('keeps http, https, mailto and tel URLs', () => {
    for (const ok of ['https://example.com/listing/1?x=1#y', 'http://example.com', 'mailto:pat@example.test', 'tel:+15125550100', 'HTTPS://EXAMPLE.COM'])
      expect(safeUrl(ok)).toBe(ok);
  });

  it('trims surrounding whitespace', () => {
    expect(safeUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('rejects script-capable and other schemes, including obfuscated ones', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0000javascript:alert(1)',
      'jav&#x09;ascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'blob:https://example.com/uuid',
      'file:///etc/passwd',
      'otpauth://totp/x',
    ])
      expect(safeUrl(bad), JSON.stringify(bad)).toBeNull();
  });

  it('rejects relative, protocol-relative and empty values (data never names an in-app path)', () => {
    for (const bad of ['', '   ', '/contacts/1', '//evil.example', 'example.com', null, undefined]) expect(safeUrl(bad)).toBeNull();
  });

  it('rejects URLs with credentials, which are a phishing vector', () => {
    expect(safeUrl('https://bank.example@evil.example/')).toBeNull();
  });

  it('allows an extra scheme only when the caller names it', () => {
    expect(safeUrl('otpauth://totp/Realty%20OS:pat?secret=ABC', { allow: ['otpauth:'] })).toBe('otpauth://totp/Realty%20OS:pat?secret=ABC');
    expect(safeUrl('javascript:alert(1)', { allow: ['otpauth:'] })).toBeNull();
    // naming an extra scheme replaces the default list
    expect(safeUrl('https://example.com', { allow: ['otpauth:'] })).toBeNull();
  });
});
