# Smartis lead importer

The first adapter is deliberately limited to VK Ads. Yandex RTB, Yandex Maps,
and Urban Ads are listed as planned sources; their rows are reported as skipped
and are never rewritten using VK rules.

## Google Sheets access

The recommended setup uses an app-level Google service account. Staff do not
need to sign in to Google individually. Create a service account in Google Cloud,
enable Google Sheets API, create a JSON key, then install its email and private
key in the server environment (never commit or paste the private key into chat):

```
AGM_GOOGLE_SERVICE_ACCOUNT_EMAIL=...@....iam.gserviceaccount.com
AGM_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

Share the destination spreadsheet with the service-account email as an Editor.
Do not make the spreadsheet editable by anyone with the link. Restart the app
after changing the systemd environment. The service-account key stays only in
the server environment; access tokens are held in process memory and refreshed
automatically.

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
