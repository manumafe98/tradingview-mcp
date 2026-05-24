import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/replay.js';

export function registerReplayTools(server) {
  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date and time (interpreted in chart timezone)', {
    date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD format, e.g. "2024-01-15"). Can also include time as ISO 8601 (e.g. "2024-01-15T09:30:00"). Time is interpreted in the chart\'s configured timezone. If omitted, selects first available date.'),
    time: z.string().optional().describe('Time of day to start replay from (HH:MM or HH:MM:SS format, e.g. "09:30" or "14:30:00"). Interpreted in the chart\'s configured timezone. Combined with date parameter. Ignored if date is not provided.'),
  }, async ({ date, time }) => {
    try { return jsonResult(await core.start({ date, time })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_step', 'Advance one or more bars in replay mode', {
    steps: z.number().int().min(1).max(500).optional()
      .describe('Number of bars to advance (default 1, max 500)'),
  }, async ({ steps }) => {
    try { return jsonResult(await core.step({ steps })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
  }, async ({ speed }) => {
    try { return jsonResult(await core.autoplay({ speed })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    action: z.string().describe('Trade action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
