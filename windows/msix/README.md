# Microsoft Store (MSIX) build

`.github/workflows/msix.yml` builds an unsigned x64 `Leyline_<version>_x64.msix`
from this folder's `Package.appxmanifest` and `Assets/`. The Microsoft Store
re-signs packages on submission, so no code-signing certificate is needed.

## Partner Center values

In Partner Center, open the app → **Product management → Product identity**.
Copy these into GitHub repo variables (**Settings → Secrets and variables →
Actions → Variables**, not secrets — they are public identifiers):

| Partner Center field                 | Repo variable                 | Manifest field                        |
| ------------------------------------ | ----------------------------- | ------------------------------------- |
| Package/Identity/Name                | `MSIX_IDENTITY_NAME`          | `Package/Identity/@Name`              |
| Package/Identity/Publisher (`CN=…`)  | `MSIX_PUBLISHER`              | `Package/Identity/@Publisher`         |
| Package/Properties/PublisherDisplayName | `MSIX_PUBLISHER_DISPLAY_NAME` | `Package/Properties/PublisherDisplayName` |

Or with the GitHub CLI:

```bash
gh variable set MSIX_IDENTITY_NAME --body "12345TheAITechnology.Leyline"
gh variable set MSIX_PUBLISHER --body "CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
gh variable set MSIX_PUBLISHER_DISPLAY_NAME --body "THE AI TECHNOLOGY COMPANY LIMITED"
```

Unset variables fall back to placeholders (`TheAITechnology.Leyline`,
`CN=00000000-0000-0000-0000-000000000000`) so CI can build; a package built
with them will be rejected by the Store.

The package version is `src-tauri/tauri.conf.json` `version` plus `.0`
(e.g. `1.3.3` → `1.3.3.0`); the Store requires the last part to be 0 and each
submission to have a higher version than the last.

## Build and submit

1. Run **MSIX (Microsoft Store)** from the Actions tab (or push to
   `feat/msix-store`).
2. Download the `leyline-msix-x64` artifact and unzip it.
3. In Partner Center, create a submission → **Packages** → upload the `.msix`.
   The `runFullTrust` restricted capability needs a short justification
   (desktop app that runs a local Node API sidecar).

## Package layout

```
leyline.exe          Tauri app (frontend embedded)
node.exe             Node runtime for the sidecar (official Windows x64 build)
_up_/dist            Node API (tsc output)
_up_/public          dashboard assets
_up_/node_modules    production-only dependencies
_up_/.env.example    key names only
Assets/              tiles and logos
AppxManifest.xml     generated from Package.appxmanifest
```

No `.env` is ever packaged; the workflow fails if one is found. The app reads
user config from `%APPDATA%\com.theaiinc.leyline\.env`. Under MSIX, writes the
app makes to AppData are redirected to
`%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\Roaming\com.theaiinc.leyline\`,
so the `.env.example` it creates shows up there. Windows merges both locations
when the app reads, so a `.env` in either should be picked up (verify on a
real install).

Icons were generated with `npx tauri icon src-tauri/icons/icon.png`;
`Wide310x150Logo.png` is the icon padded onto a 310x150 transparent canvas.
