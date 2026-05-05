/**
 * Tests for all replay functions in src/core/replay.js.
 * Covers: start, step, autoplay, stop, trade, status + DI mocks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { start, step, autoplay, stop, trade, status, VALID_AUTOPLAY_DELAYS, dateTimeToTimestamp } from '../src/core/replay.js';

// ── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock evaluate function that returns scripted values.
 * Calls are tracked in .calls array.
 * @param {object} responses — map of substring→return value. First matching key wins.
 * @param {Array} [sequence] — if provided, override responses with sequential returns
 */
function mockEvaluate(responses = {}, sequence) {
  let callIdx = 0;
  const calls = [];
  const fn = async (expr) => {
    calls.push(expr);
    if (sequence && callIdx < sequence.length) return sequence[callIdx++];
    for (const [key, val] of Object.entries(responses)) {
      if (expr.includes(key)) return typeof val === 'function' ? val(callIdx++) : val;
    }
    return undefined;
  };
  fn.calls = calls;
  return fn;
}

function mockGetReplayApi() {
  return async () => 'window.__rp';
}

function mockDeps(responses = {}, sequence) {
  const evaluate = mockEvaluate(responses, sequence);
  return { _deps: { evaluate, getReplayApi: mockGetReplayApi() }, evaluate };
}

/**
 * Create mock deps that also return a chart timezone when getTimezone is called.
 * This is needed because start() now reads the chart timezone via evaluate().
 */
function mockDepsWithTz(baseResponses = {}, timezone = 'America/New_York') {
  const responses = { ...baseResponses, 'getTimezone': timezone };
  const evaluate = mockEvaluate(responses);
  return { _deps: { evaluate, getReplayApi: mockGetReplayApi() }, evaluate };
}

// ── start() ──────────────────────────────────────────────────────────────

describe('start() — date selection and polling', () => {
  it('awaits selectDate with timestamp in ms for date param', async () => {
    const { _deps, evaluate } = mockDepsWithTz({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    }, 'America/New_York');
    const result = await start({ date: '2026-03-15', _deps });
    assert.equal(result.success, true);
    assert.equal(result.replay_started, true);
    assert.equal(result.current_date, 1773532799);
    assert.equal(result.date, '2026-03-15');
    assert.equal(result.chart_timezone, 'America/New_York');
    // Verify selectDate was called with timestamp and .then()
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    assert.ok(selectCall, 'selectDate was called');
    assert.ok(selectCall.includes('.then('), 'promise is awaited via .then()');
  });

  it('calls selectFirstAvailableDate when no date given', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectFirstAvailableDate': undefined,
      'isReplayStarted': true,
      'currentDate': 946684800,
    });
    const result = await start({ _deps });
    assert.equal(result.date, '(first available)');
    const firstAvail = evaluate.calls.find(c => c.includes('selectFirstAvailableDate'));
    assert.ok(firstAvail, 'selectFirstAvailableDate was called');
  });

  it('throws on invalid date string', async () => {
    const { _deps } = mockDepsWithTz({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: 'not-a-date', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid date'));
        assert.ok(err.message.includes('not-a-date'));
        return true;
      },
    );
  });

  it('throws when replay not available', async () => {
    const { _deps } = mockDeps({ 'isReplayAvailable': false });
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps }),
      (err) => err.message.includes('not available'),
    );
  });

  it('polls until isReplayStarted AND currentDate are set', async () => {
    let pollCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('getTimezone')) return 'America/New_York';
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) {
        pollCount++;
        return pollCount >= 3; // becomes true on 3rd poll
      }
      if (expr.includes('currentDate')) {
        return pollCount >= 4 ? 1700000000 : null; // non-null on 4th poll
      }
      return undefined;
    };
    evaluate.calls = [];
    const result = await start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 1700000000);
    assert.ok(pollCount >= 4, 'polled multiple times');
  });

  it('throws and stops replay when polling times out (never started)', async () => {
    let stopCalled = false;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayAvailable')) return true;
      if (expr.includes('getTimezone')) return 'America/New_York';
      if (expr.includes('showReplayToolbar') || expr.includes('selectDate')) return 'ok';
      if (expr.includes('isReplayStarted')) return false; // never starts
      if (expr.includes('currentDate')) return null;
      if (expr.includes('stopReplay')) { stopCalled = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    await assert.rejects(
      () => start({ date: '2026-01-01', _deps: { evaluate, getReplayApi: mockGetReplayApi() } }),
      (err) => {
        assert.ok(err.message.includes('Replay failed to start'));
        return true;
      },
    );
    assert.ok(stopCalled, 'stopReplay called for cleanup');
  });
});

// ── start() with time parameter ──────────────────────────────────────────

describe('start() — date+time and timezone handling', () => {
  it('accepts separate time parameter (HH:MM)', async () => {
    const { _deps, evaluate } = mockDepsWithTz({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    }, 'America/New_York');
    const result = await start({ date: '2026-03-15', time: '09:30', _deps });
    assert.equal(result.success, true);
    assert.equal(result.time, '09:30');
    assert.equal(result.chart_timezone, 'America/New_York');
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    assert.ok(selectCall, 'selectDate was called');
    // Verify the timestamp corresponds to 09:30 in America/New_York, not UTC
    const expectedTs = dateTimeToTimestamp('2026-03-15', '09:30', 'America/New_York');
    assert.ok(selectCall.includes(String(expectedTs)), `timestamp should be ${expectedTs} (09:30 ET)`);
  });

  it('accepts time with seconds (HH:MM:SS)', async () => {
    const { _deps, evaluate } = mockDepsWithTz({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    }, 'America/New_York');
    const result = await start({ date: '2026-03-15', time: '14:30:45', _deps });
    assert.equal(result.time, '14:30:45');
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    assert.ok(selectCall, 'selectDate was called with HH:MM:SS time');
  });

  it('accepts ISO datetime string (date with T)', async () => {
    const { _deps, evaluate } = mockDepsWithTz({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    }, 'America/New_York');
    const result = await start({ date: '2026-03-15T09:30:00', _deps });
    assert.equal(result.success, true);
    assert.equal(result.date, '2026-03-15T09:30:00');
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    assert.ok(selectCall, 'selectDate was called');
    // Should produce same timestamp as separate date+time
    const expectedTs = dateTimeToTimestamp('2026-03-15', '09:30:00', 'America/New_York');
    assert.ok(selectCall.includes(String(expectedTs)), `timestamp should be ${expectedTs}`);
  });

  it('separate time param takes precedence over T in date string', async () => {
    const { _deps, evaluate } = mockDepsWithTz({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    }, 'America/New_York');
    // date has T14:00:00, but time is 09:30 — time param should win
    const result = await start({ date: '2026-03-15T14:00:00', time: '09:30', _deps });
    assert.equal(result.time, '09:30');
    const selectCall = evaluate.calls.find(c => c.includes('selectDate'));
    const expectedTs = dateTimeToTimestamp('2026-03-15', '09:30', 'America/New_York');
    assert.ok(selectCall.includes(String(expectedTs)), 'separate time param takes precedence');
  });

  it('throws on invalid time format', async () => {
    const { _deps } = mockDepsWithTz({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: '2026-03-15', time: '9am', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid time'));
        assert.ok(err.message.includes('9am'));
        return true;
      },
    );
  });

  it('throws on invalid time format (single digit hour)', async () => {
    const { _deps } = mockDepsWithTz({ 'isReplayAvailable': true, 'showReplayToolbar': undefined });
    await assert.rejects(
      () => start({ date: '2026-03-15', time: '9:30', _deps }),
      (err) => {
        assert.ok(err.message.includes('Invalid time'));
        return true;
      },
    );
  });

  it('time without date is ignored (backward compat)', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectFirstAvailableDate': undefined,
      'isReplayStarted': true,
      'currentDate': 946684800,
    });
    // time is provided but date is not — should use selectFirstAvailableDate
    const result = await start({ time: '09:30', _deps });
    assert.equal(result.date, '(first available)');
    assert.equal(result.time, null);  // time is only returned when date is given
    const firstAvail = evaluate.calls.find(c => c.includes('selectFirstAvailableDate'));
    assert.ok(firstAvail, 'selectFirstAvailableDate was called');
  });

  it('returns chart_timezone in response', async () => {
    const { _deps } = mockDepsWithTz({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectDate': 'ok',
      'isReplayStarted': true,
      'currentDate': 1773532799,
    }, 'Asia/Tokyo');
    const result = await start({ date: '2026-03-15', _deps });
    assert.equal(result.chart_timezone, 'Asia/Tokyo');
  });

  it('chart_timezone is null when no date provided', async () => {
    const { _deps } = mockDeps({
      'isReplayAvailable': true,
      'showReplayToolbar': undefined,
      'selectFirstAvailableDate': undefined,
      'isReplayStarted': true,
      'currentDate': 946684800,
    });
    const result = await start({ _deps });
    assert.equal(result.chart_timezone, null);
  });
});

// ── dateTimeToTimestamp() unit tests ─────────────────────────────────────

describe('dateTimeToTimestamp() — timezone conversion', () => {
  it('converts date+time in America/New_York (EST, UTC-5)', () => {
    // 2026-01-15 09:30 ET (EST, no DST) = 2026-01-15 14:30 UTC
    const ts = dateTimeToTimestamp('2026-01-15', '09:30', 'America/New_York');
    const expected = Date.UTC(2026, 0, 15, 14, 30, 0);
    assert.equal(ts, expected, `Expected ${expected}, got ${ts}`);
  });

  it('converts date+time in America/New_York (EDT, UTC-4)', () => {
    // 2026-06-15 09:30 ET (EDT, with DST) = 2026-06-15 13:30 UTC
    const ts = dateTimeToTimestamp('2026-06-15', '09:30', 'America/New_York');
    const expected = Date.UTC(2026, 5, 15, 13, 30, 0);
    assert.equal(ts, expected, `Expected ${expected}, got ${ts}`);
  });

  it('converts date+time in UTC', () => {
    const ts = dateTimeToTimestamp('2026-03-15', '12:00', 'UTC');
    const expected = Date.UTC(2026, 2, 15, 12, 0, 0);
    assert.equal(ts, expected, `UTC should pass through unchanged`);
  });

  it('converts date+time in Asia/Tokyo (UTC+9, no DST)', () => {
    // 2026-03-15 09:00 JST = 2026-03-15 00:00 UTC
    const ts = dateTimeToTimestamp('2026-03-15', '09:00', 'Asia/Tokyo');
    const expected = Date.UTC(2026, 2, 15, 0, 0, 0);
    assert.equal(ts, expected, `Expected ${expected}, got ${ts}`);
  });

  it('defaults to midnight when no time provided', () => {
    // 2026-03-15 00:00 UTC = 2026-03-15 00:00 UTC
    const ts = dateTimeToTimestamp('2026-03-15', null, 'UTC');
    const expected = Date.UTC(2026, 2, 15, 0, 0, 0);
    assert.equal(ts, expected);
  });

  it('handles time with seconds (HH:MM:SS)', () => {
    const ts = dateTimeToTimestamp('2026-03-15', '09:30:45', 'UTC');
    const expected = Date.UTC(2026, 2, 15, 9, 30, 45);
    assert.equal(ts, expected);
  });

  it('handles midnight (00:00) correctly', () => {
    const ts = dateTimeToTimestamp('2026-03-15', '00:00', 'America/New_York');
    // 2026-03-15 is during EDT (DST), so midnight ET = 04:00 UTC
    const expected = Date.UTC(2026, 2, 15, 4, 0, 0);
    assert.equal(ts, expected, `Midnight ET should be 04:00 UTC during EDT`);
  });
});

// ── step() ───────────────────────────────────────────────────────────────

describe('step() — doStep and polling', () => {
  it('calls doStep and polls until currentDate changes', async () => {
    let stepDone = false;
    let dateReadCount = 0;
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) {
        dateReadCount++;
        // First read (before) returns 1000, then after doStep: 1000 twice, then 2000
        if (!stepDone) return 1000;
        return dateReadCount >= 4 ? 2000 : 1000;
      }
      if (expr.includes('doStep')) { stepDone = true; return undefined; }
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.current_date, 2000);
    assert.equal(result.action, 'step');
  });

  it('returns stale date if poll times out (date never changes)', async () => {
    const evaluate = async (expr) => {
      if (expr.includes('isReplayStarted')) return true;
      if (expr.includes('currentDate')) return 5000; // never changes
      if (expr.includes('doStep')) return undefined;
      return undefined;
    };
    evaluate.calls = [];
    const result = await step({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.current_date, 5000);
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => step({ _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── autoplay() ───────────────────────────────────────────────────────────

describe('autoplay() — delay validation', () => {
  for (const delay of VALID_AUTOPLAY_DELAYS) {
    it(`accepts valid delay ${delay}ms`, async () => {
      const { _deps } = mockDeps({
        'isReplayStarted': true,
        'changeAutoplayDelay': undefined,
        'toggleAutoplay': undefined,
        'isAutoplayStarted': true,
        'autoplayDelay': delay,
      });
      const result = await autoplay({ speed: delay, _deps });
      assert.equal(result.success, true);
      assert.equal(result.delay_ms, delay);
    });
  }

  const INVALID_DELAYS = [50, 60000, 99, 101, 500, 750, 1500, 9999, 20000];
  for (const delay of INVALID_DELAYS) {
    it(`rejects invalid delay ${delay}ms before any CDP call`, async () => {
      const { _deps, evaluate } = mockDeps({});
      await assert.rejects(
        () => autoplay({ speed: delay, _deps }),
        (err) => {
          assert.ok(err.message.includes('Invalid autoplay delay'));
          assert.ok(err.message.includes(String(delay)));
          return true;
        },
      );
      // No CDP calls should have been made
      assert.equal(evaluate.calls.length, 0, 'no CDP calls for invalid speed');
    });
  }

  it('toggles without changing speed when speed is 0', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': true,
      'autoplayDelay': 100,
    });
    const result = await autoplay({ speed: 0, _deps });
    assert.equal(result.success, true);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called for speed=0');
  });

  it('toggles without changing speed when speed omitted', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'toggleAutoplay': undefined,
      'isAutoplayStarted': false,
      'autoplayDelay': 300,
    });
    const result = await autoplay({ _deps });
    assert.equal(result.autoplay_active, false);
    const changeCall = evaluate.calls.find(c => c.includes('changeAutoplayDelay'));
    assert.equal(changeCall, undefined, 'changeAutoplayDelay not called when speed omitted');
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => autoplay({ speed: 1000, _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── stop() ───────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('calls stopReplay when started', async () => {
    const { _deps, evaluate } = mockDeps({
      'isReplayStarted': true,
      'stopReplay': undefined,
    });
    const result = await stop({ _deps });
    assert.equal(result.success, true);
    assert.equal(result.action, 'replay_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.ok(stopCall, 'stopReplay was called');
  });

  it('returns already_stopped when not started', async () => {
    const { _deps, evaluate } = mockDeps({ 'isReplayStarted': false });
    const result = await stop({ _deps });
    assert.equal(result.action, 'already_stopped');
    const stopCall = evaluate.calls.find(c => c.includes('stopReplay'));
    assert.equal(stopCall, undefined, 'stopReplay not called');
  });

  it('does not call hideReplayToolbar', () => {
    const source = readFileSync(new URL('../src/core/replay.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('hideReplayToolbar'), 'hideReplayToolbar must not appear anywhere');
  });
});

// ── trade() ──────────────────────────────────────────────────────────────

describe('trade()', () => {
  for (const action of ['buy', 'sell', 'close']) {
    it(`executes ${action} action`, async () => {
      const { _deps, evaluate } = mockDeps({
        'isReplayStarted': true,
        [action === 'close' ? 'closePosition' : action]: undefined,
        'position': 1,
        'realizedPL': 50.5,
      });
      const result = await trade({ action, _deps });
      assert.equal(result.success, true);
      assert.equal(result.action, action);
      assert.equal(result.position, 1);
      assert.equal(result.realized_pnl, 50.5);
    });
  }

  it('throws on invalid action', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': true });
    await assert.rejects(
      () => trade({ action: 'hold', _deps }),
      (err) => err.message.includes('Invalid action'),
    );
  });

  it('throws when replay not started', async () => {
    const { _deps } = mockDeps({ 'isReplayStarted': false });
    await assert.rejects(
      () => trade({ action: 'buy', _deps }),
      (err) => err.message.includes('not started'),
    );
  });
});

// ── status() ─────────────────────────────────────────────────────────────

describe('status()', () => {
  it('returns full status object', async () => {
    let callIdx = 0;
    const evaluate = async (expr) => {
      callIdx++;
      // Call 1: big inline IIFE for status fields
      if (callIdx === 1) {
        return {
          is_replay_available: true,
          is_replay_started: true,
          is_autoplay_started: false,
          replay_mode: 'ActiveChart',
          current_date: 1700000000,
          autoplay_delay: 1000,
        };
      }
      // Call 2: position
      if (callIdx === 2) return 2;
      // Call 3: realizedPL
      if (callIdx === 3) return 123.45;
      return undefined;
    };
    evaluate.calls = [];
    const result = await status({ _deps: { evaluate, getReplayApi: mockGetReplayApi() } });
    assert.equal(result.success, true);
    assert.equal(result.is_replay_started, true);
    assert.equal(result.current_date, 1700000000);
    assert.equal(result.position, 2);
    assert.equal(result.realized_pnl, 123.45);
  });
});
