/**
 * Core position drawing logic — three-attempt strategy for native shape + manual fallback.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

function calcMetrics({ entry, stop, target, direction, accountSize, riskPercent, lotSize, leverage }) {
  const riskDist = Math.abs(entry - stop);
  const rewardDist = Math.abs(target - entry);
  const riskReward = riskDist > 0 ? parseFloat((rewardDist / riskDist).toFixed(2)) : 0;
  const riskAmt = (accountSize * riskPercent) / 100;
  const rewardAmt = parseFloat((riskAmt * riskReward).toFixed(2));
  return {
    risk_distance: riskDist,
    reward_distance: rewardDist,
    risk_reward_ratio: riskReward,
    risk_amount: riskAmt,
    reward_amount: rewardAmt,
  };
}

function barTime(deps) {
  return deps?.barTime || 0;
}

async function getChartTimezone(deps) {
  const { evaluate, getChartApi } = _resolve(deps);
  const apiPath = await getChartApi();
  try {
    return await evaluate(`${apiPath}.getTimezone()`) || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function getBarTime(deps) {
  if (deps?.barTime) return deps.barTime;
  const { evaluate, getChartApi } = _resolve(deps);
  const apiPath = await getChartApi();
  const rp = await evaluate(`window.TradingViewApi._replayApiWV && window.TradingViewApi._replayApiWV.value()`);
  if (rp && rp.isReplayStarted && rp.isReplayStarted()) {
    const cd = rp.currentDate();
    if (cd) return cd;
  }
  try {
    const vr = await evaluate(`${apiPath}.getVisibleRange()`);
    return (vr && vr.to) ? vr.to : 0;
  } catch {
    return 0;
  }
}

export { dateTimeToTimestamp } from './replay.js';

async function drawManualFallback({ entry, stop, target, direction, barTime: bt, deps }) {
  const { evaluate, getChartApi } = _resolve(deps);
  const apiPath = await getChartApi();
  const ids = [];

  const isLong = direction === 'long';
  const zoneColor = isLong ? 'rgba(0,180,0,0.15)' : 'rgba(180,0,0,0.15)';
  const zoneBorder = isLong ? '#00b400' : '#b40000';
  const entryColor = isLong ? '#00b400' : '#b40000';

  const rectShape = isLong ? 'rectangle' : 'rectangle';
  const profitShape = isLong ? 'rectangle' : 'rectangle';

  const entryTop = isLong ? target : entry;
  const entryBot = isLong ? entry : stop;
  const stopTop = isLong ? entry : target;
  const stopBot = isLong ? stop : entry;

  async function makeShape(shape, point, point2, ovr) {
    const overridesStr = JSON.stringify(ovr || {});
    const textStr = JSON.stringify(ovr?.text || '');
    const p1time = requireFinite(point.time, 'point.time');
    const p1price = requireFinite(point.price, 'point.price');
    const before = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    if (point2) {
      const p2time = requireFinite(point2.time, 'point2.time');
      const p2price = requireFinite(point2.price, 'point2.price');
      await evaluate(`${apiPath}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p2time},price:${p2price}}],{shape:${safeString(shape)},overrides:${overridesStr},text:${textStr}})`);
    } else {
      await evaluate(`${apiPath}.createShape({time:${p1time},price:${p1price}},{shape:${safeString(shape)},overrides:${overridesStr},text:${textStr}})`);
    }
    await new Promise(r => setTimeout(r, 150));
    const after = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    return (after || []).find(id => !(before || []).includes(id)) || null;
  }

  const t = bt || 0;

  const profitRect = await makeShape('rectangle', { time: t, price: entryTop }, { time: t, price: entryBot }, {
    backColor: zoneColor, borderColor: zoneBorder, borderWidth: 1, lineWidth: 1,
  });
  if (profitRect) ids.push(profitRect);

  const stopRect = await makeShape('rectangle', { time: t, price: stopTop }, { time: t, price: stopBot }, {
    backColor: 'rgba(255,60,60,0.15)', borderColor: '#ff3c3c', borderWidth: 1, lineWidth: 1,
  });
  if (stopRect) ids.push(stopRect);

  const entryLine = await makeShape('horizontal_line', { time: t, price: entry }, undefined, {
    color: entryColor, linewidth: 1, linestyle: 2,
  });
  if (entryLine) ids.push(entryLine);

  const targetLine = await makeShape('horizontal_line', { time: t, price: target }, undefined, {
    color: '#00b400', linewidth: 1, linestyle: 0,
  });
  if (targetLine) ids.push(targetLine);

  const stopLine = await makeShape('horizontal_line', { time: t, price: stop }, undefined, {
    color: '#ff3c3c', linewidth: 1, linestyle: 0,
  });
  if (stopLine) ids.push(stopLine);

  const rr = isLong ? ((target - entry) / (entry - stop)).toFixed(2) : ((entry - target) / (stop - entry)).toFixed(2);
  const labelText = `${isLong ? '▲' : '▼'} ${direction.toUpperCase()} | Entry ${entry} | R:R ${rr} | Lot 1`;
  const label = await makeShape('text', { time: t, price: entry }, undefined, {
    text: labelText, color: entryColor, fontsize: 10,
  });
  if (label) ids.push(label);

  return ids;
}

async function drawNativeShape({ shapeType, entry, stop, target, accountSize, riskPercent, lotSize, leverage, barTime: bt, deps }) {
  const { evaluate, getChartApi } = _resolve(deps);
  const apiPath = await getChartApi();
  const t = bt || (await getBarTime(deps)) || 0;

  const overrides = {
    profitLevel: target,
    stopLevel: stop,
    accountSize: accountSize || 1000,
    risk: riskPercent || 2,
    lotSize: lotSize || 1,
    leverage: leverage || 1,
  };

  const overridesStr = JSON.stringify(overrides);
  const p1time = requireFinite(t, 'barTime');
  const p1price = requireFinite(entry, 'entry');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);

  let shapeId = null;

  // Attempt 1: createShape (single anchor)
  try {
    await evaluate(`${apiPath}.createShape({time:${p1time},price:${p1price}},{shape:${safeString(shapeType)},overrides:${overridesStr}})`);
    await new Promise(r => setTimeout(r, 250));
    const after = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    shapeId = (after || []).find(id => !(before || []).includes(id));
    if (shapeId) return { method: 'createShape', entity_id: shapeId };
  } catch {}

  // Attempt 2: createMultipointShape (3 points)
  const p2time = requireFinite(t, 'barTime');
  const p2price = requireFinite(target, 'target');
  const p3time = requireFinite(t, 'barTime');
  const p3price = requireFinite(stop, 'stop');
  try {
    await evaluate(`${apiPath}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p2time},price:${p2price}},{time:${p3time},price:${p3price}}],{shape:${safeString(shapeType)},overrides:${overridesStr}})`);
    await new Promise(r => setTimeout(r, 250));
    const after2 = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    shapeId = (after2 || []).find(id => !(before || []).includes(id));
    if (shapeId) return { method: 'createMultipointShape_3pt', entity_id: shapeId };
  } catch {}

  // Attempt 3: createMultipointShape (2 points)
  try {
    await evaluate(`${apiPath}.createMultipointShape([{time:${p1time},price:${p1price}},{time:${p3time},price:${p3price}}],{shape:${safeString(shapeType)},overrides:${overridesStr}})`);
    await new Promise(r => setTimeout(r, 250));
    const after3 = await evaluate(`${apiPath}.getAllShapes().map(function(s){return s.id;})`);
    shapeId = (after3 || []).find(id => !(before || []).includes(id));
    if (shapeId) return { method: 'createMultipointShape_2pt', entity_id: shapeId };
  } catch {}

  return null;
}

export async function drawPosition({ direction, entry, stop, target, accountSize, riskPercent, lotSize, leverage, _deps }) {
  const deps = _deps || {};
  const barTime = deps.barTime || await getBarTime(deps);

  if (direction === 'short') {
    if (stop <= entry) throw new Error('Short stop must be ABOVE entry price');
    if (target >= entry) throw new Error('Short target must be BELOW entry price');
  } else {
    if (stop >= entry) throw new Error('Long stop must be BELOW entry price');
    if (target <= entry) throw new Error('Long target must be ABOVE entry price');
  }

  const shapeType = direction === 'short' ? 'short_position' : 'long_position';

  const native = await drawNativeShape({
    shapeType, entry, stop, target,
    accountSize: accountSize || 1000,
    riskPercent: riskPercent || 2,
    lotSize: lotSize || 1,
    leverage: leverage || 1,
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
      stop_price: stop,
      target_price: target,
      account_size: accountSize || 1000,
      risk_percent: riskPercent || 2,
      lot_size: lotSize || 1,
      leverage: leverage || 1,
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
    stop_price: stop,
    target_price: target,
    account_size: accountSize || 1000,
    risk_percent: riskPercent || 2,
    lot_size: lotSize || 1,
    leverage: leverage || 1,
    note: 'Native long_position/short_position shape was not available. Manual fallback rendered.',
    metrics,
  };
}

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
      try { for (var key in shape) { if (typeof shape[key] === 'function') props.methods.push(key); } } catch(e) {}
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { props.name = shape.name; } catch(e) {}
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

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