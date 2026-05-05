/**
 * Core position drawing logic — three-attempt strategy for native shape + manual fallback.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getChartApi: deps?.getChartApi || _getChartApi,
  };
}

export { dateTimeToTimestamp } from './replay.js';

// ── getBarTime ────────────────────────────────────────────────────────────────
//
// Returns the Unix timestamp (SECONDS) to anchor the position box to.
//
// WHY this must run entirely inside CDP (inside the evaluate string):
//
//   connection.js calls `evaluate` with `returnByValue: true`.  When the CDP
//   result is a primitive (number, boolean, string) it comes back correctly.
//   But TradingView's internal objects (replayApi, WatchedValue wrappers, etc.)
//   are non-serialisable — CDP returns `undefined` for them.  Any attempt to
//   call methods on the Node.js side (e.g. `rp.currentDate()`) therefore throws
//   "Cannot read property of undefined", silently swallowed by a caller's
//   try-catch.
//
//   The fix: keep EVERYTHING in the browser context, only return the final
//   primitive number we need.
//
// Priority order:
//   1. In replay mode  → replayApi.currentDate()   (authoritative replay position)
//   2. Not in replay   → bars.lastIndex() bar time  (current live bar)
//
// The replay path uses `window.TradingViewApi._replayApi` (the simple property,
// not the WatchedValue wrapper `_replayApiWV`) because `_replayApi` exposes
// the methods directly without needing to call .value() first on the outer
// wrapper — though we still unwrap WatchedValue returns from the API methods
// themselves (isReplayStarted / currentDate are often WatchedValue instances).

async function getBarTime(evaluate) {
  const t = await evaluate(`
    (function() {
      // ── Attempt 1: replay mode — use the replay API's current position ──────
      // This is the authoritative timestamp the user navigated to via replay_start.
      // It correctly reflects the chart timezone conversion done in start().
      try {
        var rp = window.TradingViewApi && window.TradingViewApi._replayApi;
        if (rp) {
          // isReplayStarted() may itself be a WatchedValue — unwrap it
          var started = typeof rp.isReplayStarted === 'function' ? rp.isReplayStarted() : false;
          if (started && typeof started === 'object' && typeof started.value === 'function') {
            started = started.value();
          }

          if (started) {
            // currentDate() is also sometimes a WatchedValue
            var cd = typeof rp.currentDate === 'function' ? rp.currentDate() : null;
            if (cd && typeof cd === 'object' && typeof cd.value === 'function') {
              cd = cd.value();
            }
            // Must be a positive number (unix seconds)
            if (typeof cd === 'number' && cd > 0) return cd;
          }
        }
      } catch (e) {
        // _replayApi not available or replay not initialised — fall through
      }

      // ── Attempt 2: not in replay — use the last bar's open timestamp ─────────
      try {
        var bars = window.TradingViewApi
          ._activeChartWidgetWV.value()
          ._chartWidget.model().mainSeries().bars();
        var v = bars.valueAt(bars.lastIndex());
        if (v && typeof v[0] === 'number' && v[0] > 0) return v[0];
      } catch (e) {}

      return null;
    })()
  `);
  return t;
}

// ── calcMetrics ───────────────────────────────────────────────────────────────

function calcMetrics({ entry, stop, target, direction, accountSize, riskPercent, lotSize, leverage }) {
  const riskDist   = Math.abs(entry - stop);
  const rewardDist = Math.abs(target - entry);
  const rr = riskDist > 0 ? parseFloat((rewardDist / riskDist).toFixed(2)) : 0;
  const riskAmt   = (accountSize * riskPercent) / 100;
  const rewardAmt = parseFloat((riskAmt * rr).toFixed(2));
  return {
    risk_distance:     riskDist,
    reward_distance:   rewardDist,
    risk_reward_ratio: rr,
    risk_amount:       riskAmt,
    reward_amount:     rewardAmt,
  };
}

// ── drawNativeShape ───────────────────────────────────────────────────────────

async function drawNativeShape({ shapeType, entry, stop, target, accountSize, riskPercent, lotSize, leverage, barTime: bt, deps }) {
  const { evaluate, getChartApi } = _resolve(deps);
  const apiPath = await getChartApi();
  const t = bt || (await getBarTime(evaluate)) || 0;

  const overrides = {
    profitLevel:  target,
    stopLevel:    stop,
    accountSize:  accountSize || 1000,
    risk:         riskPercent || 2,
    lotSize:      lotSize || 1,
    leverage:     leverage || 1,
  };

  // Get tick size and convert profitLevel/stopLevel to tick offsets from entry.
  // TV's long_position/short_position ignores absolute prices; it needs ticks.
  try {
    const ps = await evaluate(`
      (function() {
        var cw = ${apiPath};
        try { return cw._chartWidget.model().mainSeries()._priceStep || 1; }
        catch(e) { return 1; }
      })()
    `);
    const tickSize = typeof ps === 'number' && ps > 0 ? ps : 1;
    if (tickSize > 0 && tickSize !== 1) {
      overrides.profitLevel = Math.abs(target - entry) / tickSize;
      overrides.stopLevel   = Math.abs(entry - stop) / tickSize;
    }
  } catch (_) {}

  const overridesStr = JSON.stringify(overrides);
  const p1time = requireFinite(t, 'barTime');
  const p1price = requireFinite(entry, 'entry');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);

  let shapeId = null;
  let method = null;

  // Attempt 1: createMultipointShape with 3 points (entry, target, stop)
  const p2time = requireFinite(t, 'barTime');
  const p2price = requireFinite(target, 'target');
  const p3time = requireFinite(t, 'barTime');
  const p3price = requireFinite(stop, 'stop');
  if (!shapeId) {
    try {
      await evaluate(`${apiPath}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p2time},price:${p2price}},{time:${p3time},price:${p3price}}],{shape:${safeString(shapeType)},overrides:${overridesStr}})`);
      await new Promise(r => setTimeout(r, 250));
      const after2 = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
      shapeId = (after2 || []).find(id => !(before || []).includes(id));
      if (shapeId) method = 'createMultipointShape_3pt';
    } catch {}
  }

  // Attempt 2: createMultipointShape with 2 points
  if (!shapeId) {
    try {
      await evaluate(`${apiPath}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p3time},price:${p3price}}],{shape:${safeString(shapeType)},overrides:${overridesStr}})`);
      await new Promise(r => setTimeout(r, 250));
      const after3 = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
      shapeId = (after3 || []).find(id => !(before || []).includes(id));
      if (shapeId) method = 'createMultipointShape_2pt';
    } catch {}
  }

  // Overrides already include tick-based profitLevel/stopLevel at creation time
  if (shapeId && method) {
    return { method, entity_id: shapeId };
  }

  return null;
}

// ── drawManualFallback ────────────────────────────────────────────────────────

async function drawManualFallback({ entry, stop, target, direction, barTime: bt, deps }) {
  const { evaluate, getChartApi } = _resolve(deps);
  const apiPath = await getChartApi();

  const isLong = direction === 'long';
  const zoneColor  = isLong ? 'rgba(0,180,0,0.15)'  : 'rgba(180,0,0,0.15)';
  const zoneBorder = isLong ? '#00b400'              : '#b40000';
  const entryColor = isLong ? '#00b400'              : '#b40000';

  const ids = [];

  const makeShape = async (shape, point, point2, ovr) => {
    const overridesStr = JSON.stringify(ovr || {});
    const textStr = JSON.stringify(ovr?.text || '');
    const p1time  = requireFinite(point.time,  'point.time');
    const p1price = requireFinite(point.price, 'point.price');
    const before = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    if (point2) {
      const p2time  = requireFinite(point2.time,  'point2.time');
      const p2price = requireFinite(point2.price, 'point2.price');
      await evaluate(`${apiPath}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p2time},price:${p2price}}],{shape:${safeString(shape)},overrides:${overridesStr},text:${textStr}})`);
    } else {
      await evaluate(`${apiPath}.createShape({time:${p1time},price:${p1price}},{shape:${safeString(shape)},overrides:${overridesStr},text:${textStr}})`);
    }
    await new Promise(r => setTimeout(r, 150));
    const after = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    const id = (after || []).find(id => !(before || []).includes(id)) || null;
    if (id) ids.push(id);
    return id;
  };

  const t = bt || 0;

  // Profit zone rectangle
  await makeShape('rectangle',
    { time: t, price: isLong ? entry : target },
    { time: t, price: isLong ? target : entry },
    { backColor: zoneColor, borderColor: zoneBorder, borderWidth: 1, lineWidth: 1 },
  );

  // Loss zone rectangle
  await makeShape('rectangle',
    { time: t, price: isLong ? stop : entry },
    { time: t, price: isLong ? entry : stop },
    { backColor: 'rgba(255,60,60,0.15)', borderColor: '#ff3c3c', borderWidth: 1, lineWidth: 1 },
  );

  // Entry line
  await makeShape('horizontal_line', { time: t, price: entry }, undefined,
    { color: entryColor, linewidth: 2, linestyle: 0,
      showLabel: true, textcolor: entryColor, text: `Entry: ${entry}`,
      horzLabelsAlign: 'right', vertLabelsAlign: 'middle' },
  );

  // Target line
  await makeShape('horizontal_line', { time: t, price: target }, undefined,
    { color: zoneBorder, linewidth: 1, linestyle: 2,
      showLabel: true, textcolor: zoneBorder, text: `Target: ${target}`,
      horzLabelsAlign: 'right', vertLabelsAlign: 'middle' },
  );

  // Stop line
  await makeShape('horizontal_line', { time: t, price: stop }, undefined,
    { color: '#ff3c3c', linewidth: 1, linestyle: 2,
      showLabel: true, textcolor: '#ff3c3c', text: `Stop: ${stop}`,
      horzLabelsAlign: 'right', vertLabelsAlign: 'middle' },
  );

  return ids;
}

// ── PUBLIC: drawPosition ──────────────────────────────────────────────────────

export async function drawPosition({ direction, entry, stop, target, accountSize, riskPercent, lotSize, leverage, _deps }) {
  const deps = _deps || {};
  const { evaluate } = _resolve(deps);

  if (direction === 'short') {
    if (stop <= entry) throw new Error('Short stop must be ABOVE entry price');
    if (target >= entry) throw new Error('Short target must be BELOW entry price');
  } else {
    if (stop >= entry) throw new Error('Long stop must be BELOW entry price');
    if (target <= entry) throw new Error('Long target must be ABOVE entry price');
  }

  // Resolve bar time — uses replay position when in replay mode
  const barTime = await getBarTime(evaluate);

  // Native long_position/short_position shapes require profitLevel/stopLevel as
  // TICK OFFSETS from entry, not absolute prices. TV's rendering ignores absolute values.
  const shapeType = direction === 'short' ? 'short_position' : 'long_position';

  const native = await drawNativeShape({
    shapeType, entry, stop, target,
    accountSize: accountSize || 1000,
    riskPercent: riskPercent || 2,
    lotSize:     lotSize || 1,
    leverage:    leverage || 1,
    barTime,
    deps,
  });

  if (native?.entity_id) {
    const metrics = calcMetrics({ entry, stop, target, direction, accountSize: accountSize || 1000, riskPercent: riskPercent || 2, lotSize: lotSize || 1, leverage: leverage || 1 });
    return {
      success: true,
      method: 'native_shape',
      shape_type: shapeType,
      creation_method: native.method,
      entity_id: native.entity_id,
      direction,
      entry_price: entry,
      stop_price:  stop,
      target_price: target,
      account_size: accountSize || 1000,
      risk_percent: riskPercent || 2,
      lot_size:     lotSize || 1,
      leverage:     leverage || 1,
      metrics,
    };
  }

  const ids = await drawManualFallback({ entry, stop, target, direction, barTime, deps });
  const metrics = calcMetrics({ entry, stop, target, direction, accountSize: accountSize || 1000, riskPercent: riskPercent || 2, lotSize: lotSize || 1, leverage: leverage || 1 });
  return {
    success: true,
    method: 'manual_fallback',
    shape_type: `${shapeType}_manual`,
    entity_ids: ids,
    direction,
    entry_price: entry,
    stop_price:  stop,
    target_price: target,
    account_size: accountSize || 1000,
    risk_percent: riskPercent || 2,
    lot_size:     lotSize || 1,
    leverage:     leverage || 1,
    note: 'Native long_position/short_position shape was not available. Manual fallback rendered.',
    metrics,
  };
}

// ── PUBLIC: inspectShape ──────────────────────────────────────────────────────

export async function inspectShape({ entity_id }) {
  const { evaluate, getChartApi } = _resolve({});
  const apiPath = await getChartApi();
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      try { for (var key in shape) { if (typeof shape[key] === 'function') props.methods = (props.methods||[]).concat(key); } } catch(e) {}
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

// ── PUBLIC: removePosition ────────────────────────────────────────────────────

export async function removePosition({ entity_id, entity_ids }) {
  const ids = entity_ids || (entity_id ? [entity_id] : []);
  if (ids.length === 0) throw new Error('No entity_id or entity_ids provided');
  const { evaluate, getChartApi } = _resolve({});
  const apiPath = await getChartApi();
  const removed = [];
  const failed = [];
  for (const id of ids) {
    try {
      const before = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
      await evaluate(`${apiPath}.removeEntity(${safeString(id)})`);
      await new Promise(r => setTimeout(r, 100));
      const after = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
      const still = after.includes(id);
      if (!still) removed.push(id); else failed.push(id);
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }
  return { success: true, removed, failed, total: ids.length };
}