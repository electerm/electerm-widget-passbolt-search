# Passbolt Search — an electerm widget

English | [中文](README_CN.md)

Search Passbolt entries from electerm and open SSH / FTP / Telnet / RDP sessions straight from the result.

There is **no UI in this folder**. `electerm.configs` in `package.json` describes the form; electerm renders it, calls `run(config)` on submit, and draws the returned object as the result area. `main.js` only exports functions, so this widget needs no core changes, no new IPC channel and no build step.

This widget is based on code by GitHub user [@palsanyi](https://github.com/palsanyi). Credit and thanks to them.

```
package.json     metadata + form definition
main.js          Passbolt client (OpenPGP + JWT) + actions
node_modules/    openpgp 6.2.2, committed with the widget
README.md        English docs (this file)
README_CN.md     Chinese docs
TESTING.md       real-account and offline-mock verification flow
scripts/         throwaway local Passbolt server for testing (docker)
```

## Install

**Settings → Widgets → Import**, then paste

```
electerm/electerm-widget-passbolt-search
```

or the full `https://github.com/electerm/electerm-widget-passbolt-search`. Import downloads the repo and copies it to `<data dir>/widgets/passbolt-search/`, so nothing has to be installed over the network afterwards.

Repository import needs electerm **v5.8.0+**. `openpgp` (~16MB) is committed in `node_modules` on purpose: import never runs `npm install`. Importing copies, it does not link — editing `main.js` in this repo afterwards changes nothing until you re-import and confirm the overwrite.

For local development, `git clone` the repo and use the **Import folder** button in the same dialog instead of the URL.

## Form fields

| Field | Type | Stored? |
| --- | --- | --- |
| Server URL | `string`, required | yes (encrypted local storage) |
| User ID | `string`, required | yes |
| GPG key file | `file`, required | path only |
| Key passphrase | `password` | **never** |
| Search | `string` | yes |

`User ID` is your UUID: in the web UI open Users / Manage Users & Groups → yourself → the UUID in `/app/users/view/<UUID>`.
Export the key with `gpg --export-secret-keys --armor <you@example.com> > me.asc`, or use "Download my key" in Passbolt settings.

`"persist": true` restores the non-password values next time. The `password` type is excluded when saving, so a passphrase cannot reach local storage.

## Actions

| Export | Called by | Arguments | Returns |
| --- | --- | --- | --- |
| `run` | submit | `(config)` | trust prompt / connected info / search result |
| `trust` | "Trust this key and connect" | `(config)` | connected info or search result |
| `details` | row button | `(row, config)` | masked password + entry fields |
| `openSsh` / `openFtp` / `openTelnet` / `openRdp` | row button | `(row, config)` | `{ openTab }` with decrypted credentials |
| `lock` | "Lock and disconnect" | `(config)` | status message |

`openTab` is opened by electerm as a normal terminal tab, tagged `from: widget:passbolt-search`; `tab.js` skips connection history for that prefix, so decrypted credentials never reach synced history.

## Security notes

- The private key file is read in the main process only; neither the key nor the passphrase is sent to Passbolt or anyone else
- The passphrase is never persisted, neither in the form store (excluded by type) nor in `.state.json`
- `.state.json` (next to `main.js`, mode 600) holds **only** the accepted server key fingerprint; delete it to be asked again
- Metadata and secrets are decrypted locally, stay in memory, and are cleared by `lock` and on exit
- Failures are reported as counts and stages, never as armor, response bodies or exception text
- The first connection asks you to compare the server fingerprint out of band; a changed fingerprint is refused until you verify the server again

## Known limitations

- The server must have the JWT authentication plugin enabled; the UUID has to be typed (the recovery-email new-device flow is not implemented)
- **No MFA support** (fails with an explicit message)
- Search covers resource metadata (name, username, description, URIs, custom fields), never secret fields
- Shared entries (`metadata_key_type: shared_key`) are skipped unless your user has a readable metadata key for them
- Both entry formats work: v4 (plaintext metadata) and v5 (encrypted metadata). The secret always comes from `GET /secrets/resource/<id>`, because the v4 `contain[secret]` view answers 400 `V4 related fields are not supported for V5` on v5 entries
- TOTP is **displayed** (secret key plus digits / period / algorithm); no one-time codes are generated
- FTP and Telnet are plaintext protocols; use them on trusted networks only
- Re-importing overwrites `.state.json` with the source copy, so the fingerprint is confirmed once more

## Offline check (no Passbolt needed)

```sh
node scripts/passbolt-mock-and-run.js
```

Starts a throwaway server on 127.0.0.1 with throwaway keys and runs the widget through connect → trust → search → details → openSsh → lock, against a Passbolt 5 style (`user_key`) encrypted resource. It prints `PASS` and removes the `.state.json` it created, so the folder stays importable. This proves the client logic, not your server's configuration.
