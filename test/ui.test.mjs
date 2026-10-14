import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AGM_PLAYWRIGHT_MODULE || 'playwright');

test('Core selection survives refresh and reading waits for plan navigation', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let pages = [
      { i: 0, title: 'First', url: 'https://core.example.test/first' },
      { i: 1, title: 'Second', url: 'https://core.example.test/second' }
    ];
    let releaseNavigation;
    const navigationResponse = new Promise(resolve => { releaseNavigation = resolve; });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/state') return route.fulfill({ json: { connected: true, pages, workbook: [], isAdmin: false } });
      if (pathname === '/api/open-plan') {
        await navigationResponse;
        return route.fulfill({ json: { activePage: 0, pages } });
      }
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

    await page.locator('#plan-url').fill('https://core.ag-media.ru/documents/mediaplans/999/edit');
    await page.locator('#open-plan').click();
    assert.equal(await page.locator('#read-plan').isDisabled(), true, 'reading must wait for navigation');
    assert.equal(await page.locator('#open-plan').isDisabled(), true, 'duplicate navigation must be blocked');
    pages = [{ ...pages[0], title: 'Refreshed during navigation' }];
    await page.clock.runFor(4100);
    await page.waitForFunction(() => document.querySelector('#core-page').textContent.includes('Refreshed during navigation'));
    assert.equal(await page.locator('#read-plan').isDisabled(), true, 'background polling must not re-enable reading during navigation');
    releaseNavigation();
    await page.waitForFunction(() => !document.querySelector('#open-plan').disabled);
    assert.equal(await page.locator('#read-plan').isEnabled(), true);
    assert.deepEqual(errors, [], 'the complete UI must initialize and refresh without JavaScript errors');
  } finally {
    await browser.close();
  }
});
