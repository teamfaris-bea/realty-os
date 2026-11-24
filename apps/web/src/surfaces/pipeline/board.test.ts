import { describe, expect, it } from 'vitest';
import { boardDefinition, countLabel, stageDefinition } from './board.js';

describe('pipeline board definitions', () => {
  it('starts from everyone, then adds an owner and a stage without dropping the list', () => {
    const list = { v: 1 as const, all: [{ kind: 'tag', op: 'any', tagIds: ['t1'] }], any: [{ kind: 'intent', in: ['buyer'] }, { kind: 'intent', in: ['seller'] }] };
    expect(boardDefinition(null, null)).toEqual({ v: 1, all: [] });
    const filtered = boardDefinition(list, 'agent-1');
    expect(filtered.all).toEqual([
      { kind: 'tag', op: 'any', tagIds: ['t1'] },
      { kind: 'owner', in: ['agent-1'] },
    ]);
    expect(filtered.any).toEqual(list.any);
    expect(stageDefinition(filtered, 'active').all?.at(-1)).toEqual({ kind: 'stage', in: ['active'] });
  });

  it('says a capped count with a plus', () => {
    expect(countLabel(4, false)).toBe('4');
    expect(countLabel(10000, true)).toBe('10,000+');
  });
});
