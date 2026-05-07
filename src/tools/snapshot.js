import { jsonResult } from './_format.js';
import * as core from '../core/snapshot.js';

export function registerSnapshotTools(server) {
  server.tool(
    'get_screenshot_link',
    'Get a shareable TradingView screenshot link (e.g., https://www.tradingview.com/x/...) by triggering Alt+S and reading the clipboard',
    {},
    async () => {
      try { return jsonResult(await core.getScreenshotLink()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
