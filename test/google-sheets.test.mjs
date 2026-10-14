import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGoogleSheetsService } from '../smartis/google-sheets.mjs';

test('service-account access signs a token and reuses it for Sheets API calls', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const service = createGoogleSheetsService({
    serviceAccountEmail: 'meiplan-test@example.iam.gserviceaccount.com',
    serviceAccountPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  });
  const previousFetch = globalThis.fetch;
  let tokenCalls = 0, sheetCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenCalls++;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, payload, signature] = form.get('assertion').split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'meiplan-test@example.iam.gserviceaccount.com');
      assert.ok(signature);
      return Response.json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    sheetCalls++;
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-access-token');
    return Response.json({ spreadsheetId: '12345678901234567890', properties: { title: 'Test' }, sheets: [] });
  };
  try {
    assert.equal(service.authMode, 'service_account');
    const session = {};
    assert.equal(service.hasSession(session), true);
    await service.metadata(session, '12345678901234567890');
    await service.metadata(session, '12345678901234567890');
    assert.equal(tokenCalls, 1);
    assert.equal(sheetCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Apps Script bridge validates its endpoint and keeps the shared key server-side', async () => {
  const service = createGoogleSheetsService();
  const secret = 'a'.repeat(64);
  assert.throws(() => service.configureAppsScript('https://example.com/exec', secret), /Apps Script/);
  service.configureAppsScript('https://script.google.com/macros/s/test_deployment_123/exec', secret);
  const previousFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://script.google.com/macros/s/test_deployment_123/exec');
    requestBody = JSON.parse(options.body);
    return Response.json({ spreadsheetId: '12345678901234567890', properties: { title: 'Test' }, sheets: [] });
  };
  try {
    assert.equal(service.authMode, 'apps_script');
    assert.equal(service.configured, true);
    const metadata = await service.metadata({}, '12345678901234567890');
    assert.equal(metadata.properties.title, 'Test');
    assert.equal(requestBody.secret, secret);
    assert.equal(requestBody.action, 'metadata');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
