/**
 * Core snapshot link logic — triggers TradingView's built-in Alt+S shortcut
 * and reads the resulting URL from the clipboard.
 */
import { getClient, evaluate } from '../connection.js';

export async function getScreenshotLink() {
  const c = await getClient();

  // Snapshot current clipboard so we don't return a stale URL from a previous snapshot
  const prevUrl = await readClipboardViaPaste(c);

  // Press Alt+S — TradingView's built-in shortcut for "Copy link to chart image"
  await c.Input.dispatchKeyEvent({
    type: 'keyDown', modifiers: 1, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });

  // Poll clipboard via paste-trick until we get a NEW valid URL or timeout
  const maxWait = 15000;
  const pollInterval = 500;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const url = await readClipboardViaPaste(c);
    if (url && url !== prevUrl && url.startsWith('https://www.tradingview.com/x/')) {
      return { success: true, url };
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // One final attempt
  const url = await readClipboardViaPaste(c);
  if (url && url !== prevUrl && url.startsWith('https://www.tradingview.com/x/')) {
    return { success: true, url };
  }

  throw new Error('Failed to get snapshot link — clipboard did not contain a fresh TradingView URL after Alt+S');
}

async function readClipboardViaPaste(c) {
  // Create invisible input, focus it, paste via Ctrl+V, read value, clean up
  await evaluate(`
    (function() {
      var inp = document.createElement('input');
      inp.id = '_tv_snapshot_clipboard';
      inp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;z-index:99999';
      document.body.appendChild(inp);
      inp.focus();
    })()
  `);

  await c.Input.dispatchKeyEvent({
    type: 'keyDown', modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'v', code: 'KeyV' });

  const url = await evaluate(`
    (function() {
      var inp = document.getElementById('_tv_snapshot_clipboard');
      if (!inp) return '';
      var val = inp.value || '';
      inp.remove();
      return val;
    })()
  `);

  return url;
}
