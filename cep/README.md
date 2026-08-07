# Unphased (CEP)

Mic alignment and phase correction for Premiere Pro — the CEP extension, for
Premiere Pro 2024/2025.

Part of the [Unphased](../README.md) project. On Premiere 26+, prefer the
[UXP version](../uxp/README.md): it bundles its own decoder and needs neither
Node nor ffmpeg.

The panel shares the Syncitol design language — bundled IBM Plex fonts, a
CSS-variable dark theme, card sections, busy spinner + progress, activity log,
tool-status chips and a slide-in instructions panel — with its own cyan accent.

## Requirements

- Windows, Premiere Pro 2024 or 2025. Premiere 2026 still loads CEP but is untested.
- System Node.js ≥ 18 on PATH (the DSP runs in your system Node, not CEP's
  embedded one).
- ffmpeg (default path `C:\ffmpeg\bin\ffmpeg.exe`; override in panel Settings).

## Install (users)

Download **`Unphased-CEP-Setup-<version>.exe`** from the
[Releases page](https://github.com/thinkvp/Unphased/releases) and run it. No
admin rights needed — it installs under your own profile. Restart Premiere, then
open **Window → Extensions → Unphased**.

The installer puts the extension in
`%APPDATA%\Adobe\CEP\extensions\com.unphased.panel` and sets `PlayerDebugMode=1`
(HKCU, CSXS 9–14) so the unsigned panel loads. It does **not** clear that flag on
uninstall: it is a shared CEP developer setting, and removing it would break any
other unsigned extension you have.

It still cannot install Node or ffmpeg for you — see Requirements above. The
panel's footer chips show what it resolved.

## Install (development)

```powershell
powershell -ExecutionPolicy Bypass -File cep\scripts\install-panel.ps1
```

This junctions `cep/` into the same location instead of copying, so edits are
live after a panel reload. The junction target is `cep/` itself, so `realpath()`
from inside the panel resolves back to the repo and `js/jobRunner.js` finds
`../engine/cli.js` beside it. If you move or rename the folder, rerun the script.

Running the installer over an existing junction is handled: it detects the
reparse point and removes the link before copying, rather than writing through
it into your checkout.

## Where the engine comes from

The DSP runs in a separate system-Node process, so `engine/` has to be reachable
from the panel. `js/jobRunner.js` looks in two places, in order:

1. `<extension>/engine/cli.js` — how the installer ships it, bundled inside the
   extension folder.
2. `<extension>/../engine/cli.js` — the repo layout, reached through the
   junction above.

`unphased.enginePath` in Settings overrides both.

## Layout

```
CSXS/manifest.xml   extension manifest (Node integration enabled)
index.html          panel markup
css/, fonts/        styling, bundled IBM Plex faces
js/bridge.js        JSON over evalScript
js/jobRunner.js     spawns system Node on the engine, streams NDJSON
js/pairing.js       clip-pair matching — shared with the UXP plugin
js/main.js          panel orchestration
jsx/host.jsx        ExtendScript host layer (ES3)
scripts/stage.js    assembles the shippable extension (cep/ + engine/)
scripts/            install helper
installer/          Inno Setup script for the Windows installer
```

## Packaging

```powershell
node scripts\stage.js
iscc installer\unphased-cep-installer.iss /DMyAppVersion=1.0.0
```

`stage.js` is the single include list — it copies the panel's runtime files
plus `engine/` (source only, no tests) into `dist/staging/`, and Inno Setup
packages that tree. CI builds the installer on every change to `cep/`.

## Troubleshooting

- **Panel missing in Extensions menu**: rerun the install script, restart
  Premiere; check the junction points at your repo.
- **"Node integration is disabled"**: the manifest ships `--enable-nodejs`; make
  sure you restarted Premiere after installing.
- **node/ffmpeg/engine not found**: set explicit paths in the panel's Settings
  section. The footer chips show what was resolved.
- **Debugging**: panel devtools at `http://localhost:8088` (older CEF — if Chrome
  refuses to attach, use Microsoft Edge). ExtendScript errors are returned in-band
  and shown in the panel status line.

## Version

`VERSION` and `CSXS/manifest.xml` carry the release number. Bump both together
with the UXP plugin:

```bash
cd uxp && node scripts/set-version.js 0.3.0 --with-cep
```
