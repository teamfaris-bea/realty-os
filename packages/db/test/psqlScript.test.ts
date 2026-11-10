// The psql-script preprocessor used to port rls_smoke.sql.
import { describe, expect, it } from 'vitest';
import { preprocessPsqlScript } from '../src/testing/psqlScript.js';

describe('preprocessPsqlScript', () => {
  it('substitutes :vars with psql quoting rules and leaves casts, literals and dollar quotes alone', () => {
    const out = preprocessPsqlScript(
      [
        "\\set t '''a0-1'''",
        "\\set H 'digest(''x'', ''sha256'')'",
        "SELECT :t::uuid, :H, ':t', \"col:t\", $q$ :t $q$, $$:t$$ -- :t",
        '/* :t /* nested :t */ */ SELECT :undefined, $1, arr[1:2];',
      ].join('\n'),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('');
    expect(lines[2]).toBe("SELECT 'a0-1'::uuid, digest('x', 'sha256'), ':t', \"col:t\", $q$ :t $q$, $$:t$$ -- :t");
    expect(lines[3]).toBe('/* :t /* nested :t */ */ SELECT :undefined, $1, arr[1:2];');
  });

  it('ignores \\o and ON_ERROR_STOP and rejects unsupported meta-commands', () => {
    expect(preprocessPsqlScript('\\set ON_ERROR_STOP on\n\\o /dev/null\nSELECT 1;')).toBe('\n\nSELECT 1;');
    expect(() => preprocessPsqlScript('\\i other.sql')).toThrow(/unsupported psql meta-command/);
  });

  it("keeps E'' backslash escapes inside the literal", () => {
    expect(preprocessPsqlScript("\\set v '1'\nSELECT E'it\\'s :v', :v;")).toBe("\nSELECT E'it\\'s :v', 1;");
  });
});
