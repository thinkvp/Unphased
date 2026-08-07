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

## Install

```powershell
powershell -ExecutionPolicy Bypass -File cep\scripts\install-panel.ps1
```

This junctions `cep/` into `%APPDATA%\Adobe\CEP\extensions\com.unphased.panel`
and sets `PlayerDebugMode=1` (HKCU, CSXS 10–12) so the unsigned panel loads.
Restart Premiere, then open **Window → Extensions → Unphased**.

The junction target is `cep/` itself, so `realpath()` from inside the panel
resolves back to the repo and `js/jobRunner.js` finds `../engine/cli.js` next to
it. If you move or rename the folder, rerun the script.

## Layout

```
CSXS/manifest.xml   extension manifest (Node integration enabled)
index.html          panel markup
css/, fonts/        styling, bundled IBM Plex faces
js/bridge.js        JSON over evalScript
js/jobRunner.js     spawns system Node on ../engine/cli.js, streams NDJSON
js/pairing.js       clip-pair matching — shared with the UXP plugin
js/main.js          panel orchestration
jsx/host.jsx        ExtendScript host layer (ES3)
scripts/            install helper
```

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
