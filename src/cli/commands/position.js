import { register } from '../router.js';
import * as core from '../../core/position.js';

register('position', {
  description: 'Draw long/short position boxes with entry/stop/target levels',
  subcommands: new Map([
    ['long', {
      description: 'Draw a long position box',
      options: {
        entry: { type: 'number', short: 'e', description: 'Entry price', required: true },
        stop: { type: 'number', short: 's', description: 'Stop loss price (below entry)', required: true },
        target: { type: 'number', short: 't', description: 'Profit target price (above entry)', required: true },
        account: { type: 'number', description: 'Account size (default 1000)' },
        risk: { type: 'number', description: 'Risk percent (default 2)' },
        lot: { type: 'number', description: 'Lot size (default 1)' },
        leverage: { type: 'number', description: 'Leverage (default 1)' },
      },
      handler: (opts) => core.drawPosition({
        direction: 'long',
        entry: Number(opts.entry),
        stop: Number(opts.stop),
        target: Number(opts.target),
        accountSize: opts.account ? Number(opts.account) : undefined,
        riskPercent: opts.risk ? Number(opts.risk) : undefined,
        lotSize: opts.lot ? Number(opts.lot) : undefined,
        leverage: opts.leverage ? Number(opts.leverage) : undefined,
      }),
    }],
    ['short', {
      description: 'Draw a short position box',
      options: {
        entry: { type: 'number', short: 'e', description: 'Entry price', required: true },
        stop: { type: 'number', short: 's', description: 'Stop loss price (above entry)', required: true },
        target: { type: 'number', short: 't', description: 'Profit target price (below entry)', required: true },
        account: { type: 'number', description: 'Account size (default 1000)' },
        risk: { type: 'number', description: 'Risk percent (default 2)' },
        lot: { type: 'number', description: 'Lot size (default 1)' },
        leverage: { type: 'number', description: 'Leverage (default 1)' },
      },
      handler: (opts) => core.drawPosition({
        direction: 'short',
        entry: Number(opts.entry),
        stop: Number(opts.stop),
        target: Number(opts.target),
        accountSize: opts.account ? Number(opts.account) : undefined,
        riskPercent: opts.risk ? Number(opts.risk) : undefined,
        lotSize: opts.lot ? Number(opts.lot) : undefined,
        leverage: opts.leverage ? Number(opts.leverage) : undefined,
      }),
    }],
    ['inspect', {
      description: 'Inspect shape properties for debugging native shape overrides',
      handler: (opts, positionals) => core.inspectShape({ entity_id: positionals[0] }),
    }],
    ['remove', {
      description: 'Remove position shape(s) by entity ID(s)',
      handler: (opts, positionals) => core.removePosition({
        entity_ids: positionals.length > 0 ? positionals : undefined,
        entity_id: positionals.length === 1 ? positionals[0] : undefined,
      }),
    }],
  ]),
});