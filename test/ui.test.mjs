import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AGM_PLAYWRIGHT_MODULE || 'playwright');

test('Core tab selection survives background refresh and falls back when the tab closes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let pages = [
      { i: 0, title: 'First', url: 'https://core.example.test/first' },
      { i: 1, title: 'Second', url: 'https://core.example.test/second' }
    ];
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/state') return route.fulfill({ json: { connected: true, pages, workbook: [], isAdmin: false } });
      if (pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { error: 'No browser snapshot in this fixture' } });
      const filename = pathname === '/' ? 'index.html' : pathname.slice('/public/'.length);
      if (!/^[a-z-]+\.(?:html|js|css|png)$/.test(filename)) return route.abort();
      return route.fulfill({
        body: fs.readFileSync(new URL(`../public/${filename}`, import.meta.url)),
        contentType: { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png' }[filename.split('.').at(-1)]
      });
    });
    await page.clock.install();
    await page.goto('http://meiplan.test/');
    const select = page.locator('#core-page');
    await select.selectOption('1');
    pages = pages.map(item => ({ ...item, title: `${item.title} refreshed` }));
    await page.clock.runFor(4100);
    await page.waitForFunction(() => document.querySelector('#core-page').textContent.includes('refreshed'));
    assert.equal(await select.inputValue(), '1', 'polling must preserve the user-selected Core tab');

    pages = [{ ...pages[0], title: 'Remaining tab' }];
    await page.clock.runFor(4100);
    await page.waitForFunction(() => document.querySelector('#core-page').textContent.includes('Remaining tab'));
    assert.equal(await select.inputValue(), '0', 'a closed tab must fall back to an available tab');
    assert.deepEqual(errors, [], 'the complete UI must initialize and refresh without JavaScript errors');
  } finally {
    await browser.close();
  }
});
