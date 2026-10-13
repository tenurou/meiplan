# Smartis lead importer

The first adapter is deliberately limited to VK Ads. Yandex RTB, Yandex Maps,
and Urban Ads are listed as planned sources; their rows are reported as skipped
and are never rewritten using VK rules.

## Google Sheets access without Google Cloud or Apps Script

The LSR cumulative report is read from its public CSV view, restricted to the
configured spreadsheet and the exact `Лиды Смартис` tab. The app does not write
to Google Sheets: after deduplicating by `Smartis Person ID`, it
shows the new records as tab-separated text in the exact A:K order. Copy the
block and paste it into the first empty row, starting in column A.

The configured LSR sheet must allow viewing by anyone with its link. This is
read-only access from the app, but anyone who obtains that link can view the
sheet. The CSV reader is restricted to the configured spreadsheet ID and tab
title; it selects that tab by name and does not expose other tabs. After
pasting, run the check again to confirm those IDs are now present.

Optional direct-write integrations remain available to deployments that already
have Google OAuth, a service account, or an Apps Script bridge configured. The
manual copy flow does not require them.

## Import behavior

1. Upload a Smartis `.xlsx` export and select its worksheet.
2. Read the configured LSR sheet through its published CSV link.
3. Review the new IDs, duplicates, conflicts, unsupported sources, and warnings.
4. Copy the A:K block and paste it in Google Sheets; existing rows are not included.
5. Run the check again to verify the pasted IDs.

The default reference is spreadsheet
`1YehJBnYD02D9xJzqISHhZDmQxaLNIG4Yk_dZ4mC8uOA`, worksheet `Лиды Смартис`. A
server-side baseline stores hashes of its initial `Smartis Person ID` values,
without contacts or lead rows; the live sheet is also read for each
reconciliation so newly pasted IDs are picked up. Source rows are matched only
by `Smartis Person ID`.
Identical duplicate source rows collapse to one; conflicting rows with the same
ID are skipped. Existing duplicates are reported and preserved.

For VK, copied columns A:K use the configured order. The channel is set to
`Реклама в соц.сетях: 1`; the first recognizable phone is retained as digits,
unrecognized contact text is preserved, an absent contact is allowed, and
`post_view` stays blank because VK exports do not confirm that attribution.
Unknown platforms are not classified as VK unless the user explicitly selects
the manual VK option. This option applies only to otherwise unknown platforms.

Import history is isolated to the current app session/user directory and stores
counts and row positions, not lead IDs or contact details.
