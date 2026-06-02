import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STRATEGY_TRADES_LIMIT,
  MAX_STRATEGY_TRADES_LIMIT,
  normalizeTradePaging,
} from '../src/core/data.js';

describe('Strategy data helpers', () => {
  it('defaults to the standard trade page', () => {
    assert.deepEqual(normalizeTradePaging(), {
      limit: DEFAULT_STRATEGY_TRADES_LIMIT,
      offset: 0,
    });
  });

  it('accepts limit and offset', () => {
    assert.deepEqual(normalizeTradePaging({ limit: 250, offset: 500 }), {
      limit: 250,
      offset: 500,
    });
  });

  it('keeps max_trades as a limit alias', () => {
    assert.deepEqual(normalizeTradePaging({ max_trades: 25 }), {
      limit: 25,
      offset: 0,
    });
  });

  it('prefers limit over max_trades when both are present', () => {
    assert.deepEqual(normalizeTradePaging({ limit: 40, max_trades: 25 }), {
      limit: 40,
      offset: 0,
    });
  });

  it('clamps limit and normalizes negative offset', () => {
    assert.deepEqual(normalizeTradePaging({ limit: 50000, offset: -20 }), {
      limit: MAX_STRATEGY_TRADES_LIMIT,
      offset: 0,
    });
  });

  it('rejects non-finite paging values', () => {
    assert.throws(() => normalizeTradePaging({ limit: 'abc' }), /limit must be a finite number/);
    assert.throws(() => normalizeTradePaging({ offset: Infinity }), /offset must be a finite number/);
  });
});
