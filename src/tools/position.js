import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/position.js';

export function registerPositionTools(server) {
  server.tool('draw_position', 'Draw a long/short position box on the chart with entry/stop/target levels', {
    direction: z.enum(['long', 'short']).describe('Position direction'),
    entry_price: z.coerce.number().describe('Entry price'),
    stop_price: z.coerce.number().describe('Stop loss price'),
    target_price: z.coerce.number().describe('Profit target price'),
    account_size: z.coerce.number().optional().describe('Account size (default 1000)'),
    risk_percent: z.coerce.number().optional().describe('Risk percentage (default 2)'),
    lot_size: z.coerce.number().optional().describe('Lot size (default 1)'),
    leverage: z.coerce.number().optional().describe('Leverage (default 1)'),
  }, async ({ direction, entry_price, stop_price, target_price, account_size, risk_percent, lot_size, leverage }) => {
    try {
      return jsonResult(await core.drawPosition({ direction, entry: entry_price, stop: stop_price, target: target_price, accountSize: account_size, riskPercent: risk_percent, lotSize: lot_size, leverage }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('draw_long_position', 'Draw a long position box (entry above, target above stop)', {
    entry_price: z.coerce.number().describe('Entry price'),
    stop_price: z.coerce.number().describe('Stop loss price (must be below entry)'),
    target_price: z.coerce.number().describe('Profit target price (must be above entry)'),
    account_size: z.coerce.number().optional().describe('Account size (default 1000)'),
    risk_percent: z.coerce.number().optional().describe('Risk percentage (default 2)'),
    lot_size: z.coerce.number().optional().describe('Lot size (default 1)'),
    leverage: z.coerce.number().optional().describe('Leverage (default 1)'),
  }, async ({ entry_price, stop_price, target_price, account_size, risk_percent, lot_size, leverage }) => {
    try {
      return jsonResult(await core.drawPosition({ direction: 'long', entry: entry_price, stop: stop_price, target: target_price, accountSize: account_size, riskPercent: risk_percent, lotSize: lot_size, leverage }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('draw_short_position', 'Draw a short position box (entry below, target below stop)', {
    entry_price: z.coerce.number().describe('Entry price'),
    stop_price: z.coerce.number().describe('Stop loss price (must be above entry)'),
    target_price: z.coerce.number().describe('Profit target price (must be below entry)'),
    account_size: z.coerce.number().optional().describe('Account size (default 1000)'),
    risk_percent: z.coerce.number().optional().describe('Risk percentage (default 2)'),
    lot_size: z.coerce.number().optional().describe('Lot size (default 1)'),
    leverage: z.coerce.number().optional().describe('Leverage (default 1)'),
  }, async ({ entry_price, stop_price, target_price, account_size, risk_percent, lot_size, leverage }) => {
    try {
      return jsonResult(await core.drawPosition({ direction: 'short', entry: entry_price, stop: stop_price, target: target_price, accountSize: account_size, riskPercent: risk_percent, lotSize: lot_size, leverage }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('position_inspect_shape', 'Inspect a shape to discover its override property names (for debugging native shape failures)', {
    entity_id: z.string().describe('Entity ID from draw_list'),
  }, async ({ entity_id }) => {
    try {
      return jsonResult(await core.inspectShape({ entity_id }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('position_remove', 'Remove a position shape by entity ID (or multiple IDs for manual fallback)', {
    entity_id: z.string().optional().describe('Entity ID of the position shape'),
    entity_ids: z.array(z.string()).optional().describe('Array of entity IDs (for manual fallback shapes)'),
  }, async ({ entity_id, entity_ids }) => {
    try {
      return jsonResult(await core.removePosition({ entity_id, entity_ids }));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  });
}