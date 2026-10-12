# Smartis lead importer

The first adapter is deliberately limited to VK Ads. Yandex RTB, Yandex Maps,
and Urban Ads are listed as planned sources; their rows are reported as skipped
and are never rewritten using VK rules.

## Google Sheets access without Google Cloud

The recommended setup uses a Google Apps Script web app, so no Cloud Console
project, service-account key, or staff Google sign-in is needed. Sign in to the
Google account that owns or can edit the target sheet, then:

1. Open `script.google.com`, create a project, and paste `public/smartis-bridge.gs`.
2. In the app's administrator panel, generate a 64-character key. Replace the
   `SHARED_SECRET` placeholder in the script with that key.
3. In the Apps Script project, select **Deploy → New deployment → Web app**.
   Choose **Execute as me** and, where company policy allows, **Anyone** (or
   **Anyone, including anonymous**). Authorize the requested spreadsheet scope.
4. Paste the deployed `/exec` URL and the same key into the administrator form.

The app stores the shared key in a mode-0600 file under its private runtime data
directory. The web app only accepts requests with that key and is hard-limited
to the configured LSR spreadsheet ID. The script owner must have edit access to
the sheet; do not make the sheet public. Google Workspace administrators can
disable anonymous Apps Script web apps, in which case use the OAuth fallback or
ask the Workspace administrator to allow the deployment.

An optional per-user OAuth fallback is still supported. Configure a Google
Cloud OAuth client of type **Web application**, enable Google Sheets API, and
add this authorized redirect URI:

```
https://meiplan.ru/api/smartis/google/callback
```

Then set these values in the service environment:

```
AGM_GOOGLE_CLIENT_ID=...
AGM_GOOGLE_CLIENT_SECRET=...
```

`AGM_PUBLIC_ORIGIN` must be the HTTPS origin of the app for OAuth. Google user
tokens live only in the user's in-memory app session and are not written to disk
or logs.

## Import behavior

1. Upload a Smartis `.xlsx` export and select its worksheet.
2. Choose a spreadsheet and worksheet (service-account mode), or connect a
   Google account when using the optional OAuth fallback.
3. Review the preview, duplicates, conflicts, unsupported sources, and warnings.
4. Explicitly confirm append. Existing rows are never updated or deleted.
5. The importer rereads the sheet and verifies every inserted cell in A:K.

The default destination is the LSR cumulative report, worksheet `Лиды Смартис`,
sheet ID `1058433141`. Source rows are matched only by `Smartis Person ID`.
Identical duplicate source rows collapse to one; conflicting rows with the same
ID are skipped. Existing duplicates are reported and preserved.

For VK, columns A:K are written in the configured order. The channel is set to
`Реклама в соц.сетях: 1`; the first recognizable phone is retained as digits,
unrecognized contact text is preserved, an absent contact is allowed, and
`post_view` stays blank because VK exports do not confirm that attribution.
Unknown platforms are not classified as VK unless the user explicitly selects
the manual VK option. This option applies only to otherwise unknown platforms.

Import history is isolated to the current app session/user directory and stores
counts and row positions, not lead IDs or contact details.
