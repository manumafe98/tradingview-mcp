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
 * Dismiss any TradingView modal / confirmation dialog that may appear during
 * replay operations.  The most common one is "Continue your last replay?" which
 * blocks selectDate() from running if left open.
 *
 * IMPORTANT: this function MUST receive `evaluate` as an explicit parameter.
 * It cannot use the module-level `_evaluate` alias directly because the function
 * is called from within scopes that may use a dependency-injected stub (tests).
 *
 * Strategy: find any visible dialog/modal overlay and click its primary dismiss
 * button.  We don't try to guess *which* button is "right" — after this runs,
 * start() immediately calls selectDate(ts) which sets the exact position we want,
 * making the Continue/Start-over distinction irrelevant.
 */
async function dismissReplayModal(evaluate) {
  try {
    const dismissed = await evaluate(`
      (function() {
        // ── 1. Look for an explicit modal / dialog container ─────────────────
        var dialog =
          document.querySelector('[role="dialog"]') ||
          document.querySelector('[class*="modal"]') ||
          document.querySelector('[class*="dialog"]') ||
          document.querySelector('[class*="popup"]') ||
          document.querySelector('[class*="confirm"]') ||
          document.querySelector('[class*="overlay"]');

        if (dialog && dialog.offsetParent !== null) {
          // Click the first *visible* button inside the dialog
          var btns = dialog.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].offsetParent !== null && !btns[i].disabled) {
              btns[i].click();
              return 'dialog:' + (btns[i].textContent || '').trim().substring(0, 40);
            }
          }
        }

        // ── 2. Fall back: scan all visible buttons for replay-modal keywords ─
        // Covers: "Continue", "Continue replay", "Yes", "Ok",
        //         "Start over", "New session", "No" — anything that dismisses.
        var KEYWORDS = [
          'continue', 'yes', 'ok', 'start over', 'new session',
          'start new', 'no', 'cancel', 'close', 'got it',
        ];
        var allBtns = document.querySelectorAll('button');
        for (var j = 0; j < allBtns.length; j++) {
          var btn = allBtns[j];
          if (btn.offsetParent === null || btn.disabled) continue;
          var text = btn.textContent.trim().toLowerCase();
          // Only click buttons that look like they belong to a replay prompt.
          // Guard: the button's text must match AND a nearby ancestor must
          // contain replay-related text (avoids accidentally clicking chart btns).
          var ancestor = btn.closest('[class*="modal"], [class*="dialog"], [class*="popup"], [class*="confirm"], [role="dialog"]');
          if (!ancestor) {
            // Looser check: does the page have any visible overlay at all?
            var anyOverlay = document.querySelector('[class*="modal"],[class*="dialog"],[class*="popup"]');
            if (!anyOverlay || anyOverlay.offsetParent === null) continue;
          }
          for (var k = 0; k < KEYWORDS.length; k++) {
            if (text.indexOf(KEYWORDS[k]) !== -1) {
              btn.click();
              return 'keyword:' + text.substring(0, 40);
            }
          }
        }

        return null; // nothing to dismiss
      })()
    `);

    if (dismissed) {
      // Give TV time to animate the modal away before the next CDP call
      await new Promise(r => setTimeout(r, 400));
    }
  } catch {
    // Never throw — modal dismissal is best-effort
  }
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

  // ── Dismiss any stale modal FIRST, before doing anything else ─────────────
  // "Continue your last replay?" appears as soon as showReplayToolbar() is called
  // and must be cleared before selectDate() or selectFirstAvailableDate() can work.
  await dismissReplayModal(evaluate);

  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);

  // Show the toolbar may trigger the modal — dismiss again
  await dismissReplayModal(evaluate);

  // Read the chart's configured timezone (e.g. "America/New_York").
  // TradingView's date picker interprets times in this timezone, so we do the same.
  let chartTz = null;
  if (date) {
    chartTz = await evaluate(
      `window.TradingViewApi._activeChartWidgetWV.value().getTimezone()`
    );
  }

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
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    // Dismiss modal on every poll iteration — it can appear mid-initialization
    await dismissReplayModal(evaluate);
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  // Final dismiss after startup completes
  await dismissReplayModal(evaluate);

  return {
    success: true, replay_started: true,
    date: date || '(first available)',
    time: date ? (time || null) : null,
    chart_timezone: chartTz,
    current_date: currentDate,
  };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);

  // Dismiss any modal that may be blocking the UI before we try to step
  await dismissReplayModal(evaluate);

  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  await new Promise(r => setTimeout(r, 500));

  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    // Dismiss any modal that appeared after stepping (e.g., end-of-data prompts)
    await dismissReplayModal(evaluate);
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
    await new Promise(r => setTimeout(r, 250));
  }

  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);

  // Dismiss any modal first — autoplay can fail silently if a dialog is open
  await dismissReplayModal(evaluate);

  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);

  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));

  // Dismiss anything that opened as a result of toggling autoplay
  await dismissReplayModal(evaluate);

  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);

  // Dismiss modal first — stop may be called from a confused state
  await dismissReplayModal(evaluate);

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

  // Dismiss modal before trading — dialog can block trade execution
  await dismissReplayModal(evaluate);

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

  // Dismiss modal before reading status — status is often called to diagnose
  // problems, and a stale modal is the most common cause of frozen state
  await dismissReplayModal(evaluate);

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