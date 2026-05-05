/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
  };
}

/**
 * Convert date + time in a specific IANA timezone to a UTC millisecond timestamp.
 * Uses Intl.DateTimeFormat to resolve the correct UTC offset for the given timezone,
 * accounting for DST transitions automatically.
 *
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @param {string|null} timeStr - Time in HH:MM or HH:MM:SS format (defaults to "00:00:00")
 * @param {string} timezone - IANA timezone (e.g. "America/New_York")
 * @returns {number} millisecond UTC timestamp
 */
export function dateTimeToTimestamp(dateStr, timeStr, timezone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const timeParts = (timeStr || '00:00:00').split(':').map(Number);
  const hours = timeParts[0] || 0;
  const minutes = timeParts[1] || 0;
  const seconds = timeParts[2] || 0;

  // Build a naive UTC date as initial guess
  const utcGuess = Date.UTC(year, month - 1, day, hours, minutes, seconds);

  // Format that UTC timestamp into the target timezone to see what local time it maps to
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(utcGuess))) {
    parts[type] = parseInt(value, 10);
  }
  // hour12:false can return hour 24 for midnight — normalize to 0
  if (parts.hour === 24) parts.hour = 0;

  // Compute the difference between what the timezone gave us and what we wanted
  const tzDate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = tzDate - utcGuess; // positive = tz is ahead of UTC

  // The actual UTC timestamp is: our desired local time minus the offset
  return utcGuess - offset;
}

export async function start({ date, time, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);

  // Read the chart's configured timezone (e.g. "America/New_York").
  // TradingView's date picker interprets times in this timezone, so we do the same.
  let chartTz = null;
  if (date) {
    chartTz = await evaluate(
      `window.TradingViewApi._activeChartWidgetWV.value().getTimezone()`
    );
  }

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (date) {
    // Validate time format if provided
    if (time && !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
      throw new Error(`Invalid time: "${time}". Use HH:MM or HH:MM:SS format (e.g. "09:30" or "14:30:00").`);
    }

    // Parse date and optional time components
    let datePart = date;
    let timePart = time || null;
    if (date.includes('T')) {
      // ISO datetime string — extract date and time parts
      const [d, t] = date.split('T');
      datePart = d;
      if (!timePart) timePart = t.replace('Z', '');
    }

    // Validate date part
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format (e.g. "2025-03-01").`);
    }

    // Convert to UTC timestamp using chart timezone
    const ts = chartTz
      ? dateTimeToTimestamp(datePart, timePart, chartTz)
      : new Date(timePart ? `${datePart}T${timePart}` : datePart).getTime();

    if (isNaN(ts)) throw new Error(`Invalid date/time: "${date}"${time ? ` "${time}"` : ''}. Use YYYY-MM-DD and HH:MM format.`);
    await evaluate(`${rp}.selectDate(${ts}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  await dismissReplayModal();

  return {
    success: true, replay_started: true,
    date: date || '(first available)',
    time: date ? (time || null) : null,
    chart_timezone: chartTz,
    current_date: currentDate,
  };
}

async function dismissReplayModal() {
  try {
    const result = await evaluate(`
      (function() {
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var text = buttons[i].textContent.trim().toLowerCase();
          if (text.indexOf('continue') !== -1 || text.indexOf('replay') !== -1) {
            buttons[i].click();
            return true;
          }
        }
        return false;
      })()
    `);
    if (result) await new Promise(r => setTimeout(r, 300));
  } catch {}
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  await new Promise(r => setTimeout(r, 500));
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
    await new Promise(r => setTimeout(r, 250));
  }
  await dismissReplayModal();
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  await dismissReplayModal();
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  return { success: true, action: 'replay_stopped' };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
