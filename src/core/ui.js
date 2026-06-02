/**
 * Core UI automation logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

const STRATEGY_REPORT_RANGES = {
  range_from_chart: 'Range from chart',
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  last_365_days: 'Last 365 days',
  entire_history: 'Entire history',
  custom: 'Custom date range',
};

function assertStrategyReportRange({ range, from, to }) {
  if (!Object.prototype.hasOwnProperty.call(STRATEGY_REPORT_RANGES, range)) {
    throw new Error(`range must be one of: ${Object.keys(STRATEGY_REPORT_RANGES).join(', ')}`);
  }
  if (range === 'custom') {
    if (!from || !to) throw new Error('from and to are required when range is "custom"');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('from must use YYYY-MM-DD format');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('to must use YYYY-MM-DD format');
  }
}

export async function click({ by, value }) {
  const escaped = JSON.stringify(value);
  const result = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${escaped};
      var el = null;
      if (by === 'aria-label') el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]');
        for (var i = 0; i < candidates.length; i++) {
          var text = candidates[i].textContent.trim();
          if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; }
        }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80), aria_label: el.getAttribute('aria-label') || null, data_name: el.getAttribute('data-name') || null };
    })()
  `);
  if (!result || !result.found) throw new Error('No matching element found for ' + by + '="' + value + '"');
  return { success: true, clicked: result };
}

export async function openPanel({ panel, action }) {
  const isBottomPanel = panel === 'pine-editor' || panel === 'strategy-tester';
  if (isBottomPanel) {
    const widgetName = panel === 'pine-editor' ? 'pine-editor' : 'backtesting';
    const result = await evaluate(`
      (function() {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar not available' };
        var panel = ${JSON.stringify(panel)};
        var widgetName = ${JSON.stringify(widgetName)};
        var action = ${JSON.stringify(action)};
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
        var isOpen = !!(bottomArea && bottomArea.offsetHeight > 50);
        if (panel === 'pine-editor') { var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco'); isOpen = isOpen && !!monacoEl; }
        if (panel === 'strategy-tester') { var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]'); isOpen = isOpen && !!(stratPanel && stratPanel.offsetParent); }
        var performed = 'none';
        if (action === 'open' || (action === 'toggle' && !isOpen)) {
          if (panel === 'pine-editor') { if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab(); else if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          else { if (typeof bwb.showWidget === 'function') bwb.showWidget(widgetName); }
          performed = 'opened';
        } else if (action === 'close' || (action === 'toggle' && isOpen)) {
          if (typeof bwb.hideWidget === 'function') bwb.hideWidget(widgetName);
          performed = 'closed';
        }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  } else {
    const selectorMap = {
      'watchlist': { dataName: 'base-watchlist-widget-button', ariaLabel: 'Watchlist' },
      'alerts': { dataName: 'alerts-button', ariaLabel: 'Alerts' },
      'trading': { dataName: 'trading-button', ariaLabel: 'Trading Panel' },
    };
    const sel = selectorMap[panel];
    const result = await evaluate(`
      (function() {
        var dataName = ${JSON.stringify(sel.dataName)};
        var ariaLabel = ${JSON.stringify(sel.ariaLabel)};
        var action = ${JSON.stringify(action)};
        var btn = document.querySelector('[data-name="' + dataName + '"]') || document.querySelector('[aria-label="' + ariaLabel + '"]');
        if (!btn) return { error: 'Button not found for panel: ' + ${JSON.stringify(panel)} };
        var isActive = btn.getAttribute('aria-pressed') === 'true' || btn.classList.contains('isActive') || btn.classList.toString().indexOf('active') !== -1 || btn.classList.toString().indexOf('Active') !== -1;
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
        var isOpen = isActive && sidebarOpen;
        var performed = 'none';
        if (action === 'open' && !isOpen) { btn.click(); performed = 'opened'; }
        else if (action === 'close' && isOpen) { btn.click(); performed = 'closed'; }
        else if (action === 'toggle') { btn.click(); performed = isOpen ? 'closed' : 'opened'; }
        else { performed = isOpen ? 'already_open' : 'already_closed'; }
        return { was_open: isOpen, performed: performed };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, panel, action, was_open: result?.was_open ?? false, performed: result?.performed ?? 'unknown' };
  }
}

async function cdpClickAt(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Valid click coordinates were not provided.');
  }
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: point.x, y: point.y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

export async function setStrategyReportRange({ range, from, to } = {}) {
  assertStrategyReportRange({ range, from, to });
  await openPanel({ panel: 'strategy-tester', action: 'open' });
  await new Promise(r => setTimeout(r, 500));

  const start = await evaluateAsync(`
    (function() {
      var requestedRange = ${JSON.stringify(range)};
      var requestedLabel = ${JSON.stringify(STRATEGY_REPORT_RANGES[range])};

      function text(el) { return (el && el.textContent || '').trim().replace(/\\s+/g, ' '); }
      function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      function point(el) {
        var rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      function getStrategyReport() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          var strat = null;
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (s.metaInfo && s.metaInfo() && s.metaInfo().id && s.metaInfo().id.indexOf('StrategyScript$') === 0 && s.reportData) {
              strat = s;
              break;
            }
          }
          if (!strat) return { error: 'No strategy found on chart.' };
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd) return { error: 'Strategy reportData() returned no data.' };
          return {
            date_range: rd.settings && rd.settings.dateRange ? rd.settings.dateRange : null,
            total_trades: Array.isArray(rd.trades) ? rd.trades.length : null
          };
        } catch(e) {
          return { error: e.message };
        }
      }
      function reportKey(report) {
        return JSON.stringify({
          date_range: report && report.date_range ? report.date_range : null,
          total_trades: report ? report.total_trades : null
        });
      }
      function strategyPanel() {
        return document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtestingReport"]')
          || document.querySelector('[class*="bottom-widgetbar-content"].backtesting')
          || document;
      }
      function findRangeButton() {
        var panel = strategyPanel();
        var buttons = Array.prototype.slice.call(panel.querySelectorAll('button,[role="button"]'));
        var matches = buttons.filter(function(el) {
          var t = text(el);
          return visible(el) && (
            (/\\b\\d{4}\\b/.test(t) && /[\\u2013\\u2014-]/.test(t))
            || /^(Last 7 days|Last 30 days|Last 90 days|Last 365 days|Entire history|Range from chart)/.test(t)
          );
        });
        if (matches.length === 0) return null;
        matches.sort(function(a, b) {
          var ar = a.getBoundingClientRect();
          var br = b.getBoundingClientRect();
          return (ar.y - br.y) || (ar.x - br.x);
        });
        return matches[0];
      }

      var before = getStrategyReport();
      if (before.error) return { error: before.error };
      var rangeButton = findRangeButton();
      if (!rangeButton) return { error: 'Strategy Tester date range button was not found.' };
      return {
        requested_range: requestedRange,
        selected_label: requestedLabel,
        before: before,
        before_key: reportKey(before),
        range_button_point: point(rangeButton)
      };
    })()
  `);

  if (start?.error) throw new Error(start.error);
  await cdpClickAt(start.range_button_point);

  const menuInfo = await evaluateAsync(`
    (async function() {
      var requestedLabel = ${JSON.stringify(STRATEGY_REPORT_RANGES[range])};

      function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
      function text(el) { return (el && el.textContent || '').trim().replace(/\\s+/g, ' '); }
      function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      function point(el) {
        var rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      function findRangeMenu() {
        var menus = Array.prototype.slice.call(document.querySelectorAll('[role="menu"], [class*="popover"], [class*="portal"]'));
        for (var i = 0; i < menus.length; i++) {
          var t = text(menus[i]);
          if (visible(menus[i]) && /Testing period/.test(t) && /Entire history/.test(t)) return menus[i];
        }
        return null;
      }
      async function waitForMenu() {
        var started = Date.now();
        while (Date.now() - started < 5000) {
          var menu = findRangeMenu();
          if (menu) return menu;
          await sleep(100);
        }
        return null;
      }
      function findMenuOption(menu, label) {
        var candidates = Array.prototype.slice.call(menu.querySelectorAll('button,[role="button"],[role="menuitem"],div,span'));
        var exact = candidates.filter(function(el) {
          var t = text(el);
          return visible(el) && (t === label || (label === 'Range from chart' && t === 'Range from chartDefault'));
        });
        exact.sort(function(a, b) {
          var ac = String(a.className || '');
          var bc = String(b.className || '');
          var aBackground = ac.indexOf('background-') !== -1;
          var bBackground = bc.indexOf('background-') !== -1;
          if (aBackground !== bBackground) return aBackground ? -1 : 1;
          var aButton = ac.indexOf('button-') !== -1 || a.tagName.toLowerCase() === 'button' || a.getAttribute('role') === 'button' || a.getAttribute('role') === 'menuitem';
          var bButton = bc.indexOf('button-') !== -1 || b.tagName.toLowerCase() === 'button' || b.getAttribute('role') === 'button' || b.getAttribute('role') === 'menuitem';
          if (aButton !== bButton) return aButton ? -1 : 1;
          var ar = a.getBoundingClientRect();
          var br = b.getBoundingClientRect();
          if (Math.round(ar.width) !== Math.round(br.width)) return br.width - ar.width;
          return text(a).length - text(b).length;
        });
        if (exact.length === 0) return null;
        return exact[0];
      }
      function normalizeMenuLabel(rawText) {
        var labels = ['Range from chart', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'Last 365 days', 'Entire history', 'Custom date range'];
        for (var i = 0; i < labels.length; i++) {
          if (rawText === labels[i] || rawText.indexOf(labels[i]) === 0) return labels[i];
        }
        return rawText;
      }
      function findSelectedMenuLabel(menu) {
        var rows = Array.prototype.slice.call(menu.querySelectorAll('[class*="background-"]')).filter(function(el) {
          return visible(el) && String(el.className || '').indexOf('selected') !== -1;
        });
        if (rows.length === 0) return null;
        rows.sort(function(a, b) {
          var ar = a.getBoundingClientRect();
          var br = b.getBoundingClientRect();
          return (ar.y - br.y) || (ar.x - br.x);
        });
        return normalizeMenuLabel(text(rows[0]));
      }

      var menu = await waitForMenu();
      if (!menu) return { error: 'Strategy Tester date range menu did not open.' };
      var beforeSelectedLabel = findSelectedMenuLabel(menu);
      var option = findMenuOption(menu, requestedLabel);
      if (!option) return { error: 'Strategy Tester menu option not found: ' + requestedLabel };
      return {
        previous_selected_label: beforeSelectedLabel,
        same_requested_range: beforeSelectedLabel === requestedLabel,
        option_point: point(option)
      };
    })()
  `);

  if (menuInfo?.error) throw new Error(menuInfo.error);
  await cdpClickAt(menuInfo.option_point);

  if (range === 'custom') {
    const customInfo = await evaluateAsync(`
      (async function() {
        var customFrom = ${JSON.stringify(from || '')};
        var customTo = ${JSON.stringify(to || '')};

        function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
        function text(el) { return (el && el.textContent || '').trim().replace(/\\s+/g, ' '); }
        function visible(el) {
          if (!el) return false;
          var rect = el.getBoundingClientRect();
          var style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        }
        function point(el) {
          var rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        function setInputValue(input, value) {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
        }

        var started = Date.now();
        var inputs = [];
        while (Date.now() - started < 5000) {
          inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(function(input) {
            var type = (input.getAttribute('type') || 'text').toLowerCase();
            return visible(input) && !input.disabled && type !== 'hidden' && type !== 'checkbox' && type !== 'radio';
          });
          if (inputs.length >= 2) break;
          await sleep(100);
        }
        if (inputs.length < 2) return { error: 'Custom date range inputs were not found.' };
        inputs.sort(function(a, b) {
          var ar = a.getBoundingClientRect();
          var br = b.getBoundingClientRect();
          return (ar.y - br.y) || (ar.x - br.x);
        });
        setInputValue(inputs[0], customFrom);
        setInputValue(inputs[1], customTo);
        await sleep(100);
        var buttons = Array.prototype.slice.call(document.querySelectorAll('button,[role="button"]')).filter(visible);
        var apply = buttons.find(function(btn) { return /^(Apply|OK|Done|Save)$/i.test(text(btn)); });
        return { apply_point: apply ? point(apply) : null };
      })()
    `);

    if (customInfo?.error) throw new Error(customInfo.error);
    if (customInfo.apply_point) {
      await cdpClickAt(customInfo.apply_point);
    } else {
      const c = await getClient();
      await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  }

  const result = await evaluateAsync(`
    (async function() {
      var requestedRange = ${JSON.stringify(range)};
      var requestedLabel = ${JSON.stringify(STRATEGY_REPORT_RANGES[range])};
      var previousSelectedLabel = ${JSON.stringify(menuInfo.previous_selected_label)};
      var sameRequestedRange = ${JSON.stringify(menuInfo.same_requested_range)};
      var before = ${JSON.stringify(start.before)};
      var beforeKey = ${JSON.stringify(start.before_key)};
      var timeoutMs = 20000;

      function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
      function text(el) { return (el && el.textContent || '').trim().replace(/\\s+/g, ' '); }
      function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      function normalizeRangeText(raw) {
        var cleaned = String(raw || '').replace(/\\s*deep$/i, '').trim();
        var labels = ['Range from chart', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'Last 365 days', 'Entire history', 'Custom date range'];
        for (var i = 0; i < labels.length; i++) {
          if (cleaned === labels[i] || cleaned.indexOf(labels[i]) === 0) return labels[i];
        }
        return cleaned;
      }
      function isDateRangeText(value) {
        return /\\b\\d{4}\\b/.test(value) && /[\\u2013\\u2014-]/.test(value);
      }
      function strategyPanel() {
        return document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtestingReport"]')
          || document.querySelector('[class*="bottom-widgetbar-content"].backtesting')
          || document;
      }
      function visibleReportSummary() {
        var panel = strategyPanel();
        var panelText = text(panel);
        var totalTrades = null;
        var profitableTrades = panelText.match(/Profitable trades[\\s\\S]{0,80}?(\\d+)\\s*\\/\\s*(\\d+)/);
        if (profitableTrades) {
          totalTrades = Number(profitableTrades[2]);
        } else {
          var totalTradesMatch = panelText.match(/(\\d+)\\s*Total trades/);
          if (totalTradesMatch) totalTrades = Number(totalTradesMatch[1]);
        }
        return {
          total_trades: Number.isFinite(totalTrades) ? totalTrades : null
        };
      }
      function findRangeButtonText() {
        var panel = strategyPanel();
        var buttons = Array.prototype.slice.call(panel.querySelectorAll('button,[role="button"]'));
        var matches = buttons.filter(function(el) {
          var t = normalizeRangeText(text(el));
          return visible(el) && (
            isDateRangeText(t)
            || /^(Last 7 days|Last 30 days|Last 90 days|Last 365 days|Entire history|Range from chart)/.test(t)
          );
        });
        if (matches.length === 0) return null;
        matches.sort(function(a, b) {
          var ar = a.getBoundingClientRect();
          var br = b.getBoundingClientRect();
          return (ar.y - br.y) || (ar.x - br.x);
        });
        return normalizeRangeText(text(matches[0]));
      }
      function visibleRangeMatches(value) {
        if (!value) return false;
        if (requestedRange === 'range_from_chart' || requestedRange === 'custom' || requestedRange === 'entire_history') {
          return isDateRangeText(value) || value === requestedLabel;
        }
        return value === requestedLabel || value.indexOf(requestedLabel) === 0;
      }
      function hasVisibleLoader() {
        var loaders = document.querySelectorAll('[class*="loader"], [class*="spinner"], [aria-busy="true"]');
        for (var i = 0; i < loaders.length; i++) {
          if (visible(loaders[i])) return true;
        }
        return false;
      }
      function getStrategyReport() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          var strat = null;
          for (var i = 0; i < sources.length; i++) {
            var s = sources[i];
            if (s.metaInfo && s.metaInfo() && s.metaInfo().id && s.metaInfo().id.indexOf('StrategyScript$') === 0 && s.reportData) {
              strat = s;
              break;
            }
          }
          if (!strat) return { error: 'No strategy found on chart.' };
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd) return { error: 'Strategy reportData() returned no data.' };
          return {
            date_range: rd.settings && rd.settings.dateRange ? rd.settings.dateRange : null,
            total_trades: Array.isArray(rd.trades) ? rd.trades.length : null
          };
        } catch(e) {
          return { error: e.message };
        }
      }
      function reportKey(report) {
        return JSON.stringify({
          date_range: report && report.date_range ? report.date_range : null,
          total_trades: report ? report.total_trades : null
        });
      }

      var startedWait = Date.now();
      var visibleRangeLabel = findRangeButtonText();
      var lastVisibleRangeLabel = visibleRangeLabel;
      var stableSince = Date.now();

      while (Date.now() - startedWait < timeoutMs) {
        if (visibleRangeMatches(visibleRangeLabel) && !hasVisibleLoader() && Date.now() - stableSince >= 500) break;
        await sleep(200);
        visibleRangeLabel = findRangeButtonText();
        if (visibleRangeLabel !== lastVisibleRangeLabel) {
          lastVisibleRangeLabel = visibleRangeLabel;
          stableSince = Date.now();
        }
      }

      if (!visibleRangeMatches(visibleRangeLabel)) {
        return {
          error: 'Strategy Tester range was clicked, but the visible range did not change to: ' + requestedLabel,
          requested_range: requestedRange,
          selected_label: requestedLabel,
          previous_selected_label: previousSelectedLabel,
          visible_range_label: visibleRangeLabel,
          source: 'ui_automation'
        };
      }

      var after = getStrategyReport();
      var reportDataChanged = !after.error && reportKey(after) !== beforeKey;
      var visibleReport = visibleReportSummary();
      var reportDataMatchesVisible = !after.error
        && visibleReport.total_trades !== null
        && after.total_trades === visibleReport.total_trades;
      var reportDataSynced = visibleReport.total_trades !== null
        ? reportDataMatchesVisible
        : reportDataChanged;
      var warning = null;
      if (!reportDataSynced) {
        warning = 'Strategy Tester UI selected the requested range, but TradingView reportData() does not match the visible report. data_get_strategy_results/data_get_trades may still return the previous internal report.';
      }

      return {
        requested_range: requestedRange,
        selected_label: requestedLabel,
        previous_selected_label: previousSelectedLabel,
        visible_range_label: visibleRangeLabel,
        previous_date_range: before.date_range,
        actual_date_range: after.error ? null : after.date_range,
        report_trade_count: after.error ? null : after.total_trades,
        visible_report_trade_count: visibleReport.total_trades,
        report_error: after.error || null,
        reportData_changed: reportDataChanged,
        reportData_matches_visible: reportDataMatchesVisible,
        reportData_synced: reportDataSynced,
        warning: warning,
        source: 'ui_automation'
      };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function fullscreen() {
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="header-toolbar-fullscreen"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!result || !result.found) throw new Error('Fullscreen button not found');
  return { success: true, action: 'fullscreen_toggled' };
}

export async function layoutList() {
  const layouts = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts returned no data'}); return; }
          var result = charts.map(function(c) { return { id: c.id || c.chartId || null, name: c.name || c.title || 'Untitled', symbol: c.symbol || null, resolution: c.resolution || null, modified: c.timestamp || c.modified || null }; });
          resolve({layouts: result, source: 'internal_api'});
        });
        setTimeout(function() { resolve({layouts: [], source: 'internal_api', error: 'getSavedCharts timed out'}); }, 5000);
      } catch(e) { resolve({layouts: [], source: 'internal_api', error: e.message}); }
    })
  `);
  return { success: true, layout_count: layouts?.layouts?.length || 0, source: layouts?.source, layouts: layouts?.layouts || [], error: layouts?.error };
}

export async function layoutSwitch({ name }) {
  const escaped = JSON.stringify(name);
  const result = await evaluateAsync(`
    new Promise(function(resolve) {
      try {
        var target = ${escaped};
        if (/^\\d+$/.test(target)) { window.TradingViewApi.loadChartFromServer(target); resolve({success: true, method: 'loadChartFromServer', id: target, source: 'internal_api'}); return; }
        window.TradingViewApi.getSavedCharts(function(charts) {
          if (!charts || !Array.isArray(charts)) { resolve({success: false, error: 'getSavedCharts returned no data', source: 'internal_api'}); return; }
          var match = null;
          for (var i = 0; i < charts.length; i++) { var cname = charts[i].name || charts[i].title || ''; if (cname === target || cname.toLowerCase() === target.toLowerCase()) { match = charts[i]; break; } }
          if (!match) { for (var j = 0; j < charts.length; j++) { var cn = (charts[j].name || charts[j].title || '').toLowerCase(); if (cn.indexOf(target.toLowerCase()) !== -1) { match = charts[j]; break; } } }
          if (!match) { resolve({success: false, error: 'Layout "' + target + '" not found.', source: 'internal_api'}); return; }
          var chartId = match.id || match.chartId;
          window.TradingViewApi.loadChartFromServer(chartId);
          resolve({success: true, method: 'loadChartFromServer', id: chartId, name: match.name || match.title, source: 'internal_api'});
        });
        setTimeout(function() { resolve({success: false, error: 'getSavedCharts timed out', source: 'internal_api'}); }, 5000);
      } catch(e) { resolve({success: false, error: e.message, source: 'internal_api'}); }
    })
  `);
  if (!result?.success) throw new Error(result?.error || 'Unknown error switching layout');

  // Handle "unsaved changes" confirmation dialog
  await new Promise(r => setTimeout(r, 500));
  const dismissed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/open anyway|don't save|discard/i.test(text)) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (dismissed) await new Promise(r => setTimeout(r, 1000));
  return { success: true, layout: result.name || name, layout_id: result.id, source: result.source, action: 'switched', unsaved_dialog_dismissed: dismissed };
}

export async function keyboard({ key, modifiers }) {
  const c = await getClient();
  let mod = 0;
  if (modifiers) {
    if (modifiers.includes('alt')) mod |= 1;
    if (modifiers.includes('ctrl')) mod |= 2;
    if (modifiers.includes('meta')) mod |= 4;
    if (modifiers.includes('shift')) mod |= 8;
  }
  const keyMap = {
    'Enter': { code: 'Enter', vk: 13 }, 'Escape': { code: 'Escape', vk: 27 }, 'Tab': { code: 'Tab', vk: 9 },
    'Backspace': { code: 'Backspace', vk: 8 }, 'Delete': { code: 'Delete', vk: 46 },
    'ArrowUp': { code: 'ArrowUp', vk: 38 }, 'ArrowDown': { code: 'ArrowDown', vk: 40 },
    'ArrowLeft': { code: 'ArrowLeft', vk: 37 }, 'ArrowRight': { code: 'ArrowRight', vk: 39 },
    'Space': { code: 'Space', vk: 32 }, 'Home': { code: 'Home', vk: 36 }, 'End': { code: 'End', vk: 35 },
    'PageUp': { code: 'PageUp', vk: 33 }, 'PageDown': { code: 'PageDown', vk: 34 },
    'F1': { code: 'F1', vk: 112 }, 'F2': { code: 'F2', vk: 113 }, 'F5': { code: 'F5', vk: 116 },
  };
  const mapped = keyMap[key] || { code: 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0) };
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key, code: mapped.code, windowsVirtualKeyCode: mapped.vk });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key, code: mapped.code });
  return { success: true, key, modifiers: modifiers || [] };
}

export async function typeText({ text }) {
  const c = await getClient();
  await c.Input.insertText({ text });
  return { success: true, typed: text.substring(0, 100), length: text.length };
}

export async function hover({ by, value }) {
  const coords = await evaluate(`
    (function() {
      var by = ${JSON.stringify(by)};
      var value = ${JSON.stringify(value)};
      var el = null;
      if (by === 'aria-label') {
        el = document.querySelector('[aria-label="' + value.replace(/"/g, '\\\\"') + '"]');
        if (!el) el = document.querySelector('[aria-label*="' + value.replace(/"/g, '\\\\"') + '"]');
      }
      else if (by === 'data-name') el = document.querySelector('[data-name="' + value.replace(/"/g, '\\\\"') + '"]');
      else if (by === 'text') {
        var candidates = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], span, div');
        for (var i = 0; i < candidates.length; i++) { var text = candidates[i].textContent.trim(); if (text === value || text.toLowerCase() === value.toLowerCase()) { el = candidates[i]; break; } }
      } else if (by === 'class-contains') el = document.querySelector('[class*="' + value.replace(/"/g, '\\\\"') + '"]');
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()
  `);
  if (!coords) throw new Error('Element not found for ' + by + '="' + value + '"');
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: coords.x, y: coords.y });
  return { success: true, hovered: { by, value, tag: coords.tag, x: coords.x, y: coords.y } };
}

export async function scroll({ direction, amount }) {
  const c = await getClient();
  const px = amount || 300;
  const center = await evaluate(`
    (function() {
      var el = document.querySelector('[data-name="pane-canvas"]') || document.querySelector('[class*="chart-container"]') || document.querySelector('canvas');
      if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      var rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()
  `);
  let deltaX = 0, deltaY = 0;
  if (direction === 'up') deltaY = -px; else if (direction === 'down') deltaY = px;
  else if (direction === 'left') deltaX = -px; else if (direction === 'right') deltaX = px;
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: center.x, y: center.y, deltaX, deltaY });
  return { success: true, direction, amount: px };
}

export async function mouseClick({ x, y, button, double_click }) {
  const c = await getClient();
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
  const btnNum = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  if (double_click) {
    await new Promise(r => setTimeout(r, 50));
    await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, buttons: btnNum, clickCount: 2 });
    await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn });
  }
  return { success: true, x, y, button: btn, double_click: !!double_click };
}

export async function findElement({ query, strategy }) {
  const strat = strategy || 'text';
  const results = await evaluate(`
    (function() {
      var query = ${JSON.stringify(query)};
      var strategy = ${JSON.stringify(strat)};
      var results = [];
      if (strategy === 'css') {
        var els = document.querySelectorAll(query);
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else if (strategy === 'aria-label') {
        var els = document.querySelectorAll('[aria-label*="' + query.replace(/"/g, '\\\\"') + '"]');
        for (var i = 0; i < Math.min(els.length, 20); i++) {
          var rect = els[i].getBoundingClientRect();
          results.push({ tag: els[i].tagName.toLowerCase(), text: (els[i].textContent || '').trim().substring(0, 80), aria_label: els[i].getAttribute('aria-label') || null, data_name: els[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: els[i].offsetParent !== null });
        }
      } else {
        var all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], input, select, label, span, div, h1, h2, h3, h4');
        for (var i = 0; i < all.length; i++) {
          var text = all[i].textContent.trim();
          if (text.toLowerCase().indexOf(query.toLowerCase()) !== -1 && text.length < 200) {
            var rect = all[i].getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              results.push({ tag: all[i].tagName.toLowerCase(), text: text.substring(0, 80), aria_label: all[i].getAttribute('aria-label') || null, data_name: all[i].getAttribute('data-name') || null, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: all[i].offsetParent !== null });
              if (results.length >= 20) break;
            }
          }
        }
      }
      return results;
    })()
  `);
  return { success: true, query, strategy: strat, count: results?.length || 0, elements: results || [] };
}

export async function uiEvaluate({ expression }) {
  const result = await evaluate(expression);
  return { success: true, result };
}
