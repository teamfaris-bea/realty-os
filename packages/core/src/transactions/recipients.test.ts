import { describe, expect, it } from 'vitest';
import { otherSideRoles, reachableStepRoles, teamClientRoles, updateRoles } from './recipients.js';

describe('b8 deals sends/F1 K1 R-TXN-4: the team represents only its side of the deal', () => {
  it('buy, sell, dual and lease client roles', () => {
    expect(teamClientRoles('buy')).toEqual(['buyer', 'co_buyer']);
    expect(teamClientRoles('sell')).toEqual(['seller', 'co_seller']);
    expect([...teamClientRoles('dual')].sort()).toEqual(['buyer', 'co_buyer', 'co_seller', 'seller']);
    expect(teamClientRoles('lease')).toEqual([]);
  });
  it('the other side\'s client roles drop out; lender, title, attorney and other stay as the step names them', () => {
    expect(updateRoles('buy', ['seller'])).toEqual([]);
    expect(updateRoles('sell', ['buyer', 'co_buyer'])).toEqual([]);
    expect(updateRoles('sell', ['co_seller'])).toEqual(['co_seller']);
    expect(updateRoles('lease', ['buyer', 'lender'])).toEqual(['lender']);
    expect(updateRoles('dual', ['buyer', 'seller'])).toEqual(['buyer', 'seller']);
    expect(otherSideRoles('buy', ['seller', 'title'])).toEqual(['seller']);
    expect(otherSideRoles('lease', ['buyer'])).toEqual(['buyer']);
    expect(reachableStepRoles('buy', ['buyer', 'seller', 'co_buyer', 'co_seller', 'lender'])).toEqual(['buyer', 'co_buyer', 'lender']);
  });
});
