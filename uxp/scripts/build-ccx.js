#!/usr/bin/env node
// build-ccx.js — package the plugin as a minimal .ccx (a zip Creative Cloud
// installs on double-click).
//
// Stages ONLY what the plugin needs at runtime:
//   manifest.json, index.html, css/, fonts/,
//   js/{main,audio,runner,premiere,pairing,volume,automixRunner}.js, js/engine/*.js,
//   win/x64/unphased.uxpaddon, mac/*/unphased.uxpaddon
// Explicitly NOT staged: native/ (sources and any FFmpeg build tree), tests/,
// scripts/, node_modules/, docs. Syncitol once shipped a whole shared FFmpeg
// build by accident and the package went from 2 MB to 320 MB; the size guard at
// the bottom exists to catch a repeat.
//
// Zero npm dependencies: staging via fs, zipping via PowerShell (Windows) or
// `zip` (macOS/Linux CI).
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;

const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "stage");
const OUT = path.join(DIST, `Unphased-UXP-${version}.ccx`);

// The generated engine must match the shared source, or the .ccx ships DSP that
// no longer matches what `node --test` verified.
execFileSync(process.execPath, [path.join(__dirname, "build-engine.js"), "--check"], { stdio: "inherit" });

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

function copy(rel) {
    const src = path.join(ROOT, rel);
    const dst = path.join(STAGE, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

copy("manifest.json");
copy("index.html");
copy("css/panel.css");
for (const f of ["main.js", "audio.js", "runner.js", "premiere.js", "pairing.js", "volume.js", "automixRunner.js"]) copy(`js/${f}`);
for (const f of fs.readdirSync(path.join(ROOT, "js", "engine"))) copy(`js/engine/${f}`);
for (const f of fs.readdirSync(path.join(ROOT, "fonts"))) copy(`fonts/${f}`);

// The native addon — the whole FFmpeg story in ~2-3 MB per platform. Copy
// whichever platform addons exist so one .ccx can target both OSes.
let addons = 0;
for (const p of ["win/x64/unphased.uxpaddon", "mac/x64/unphased.uxpaddon", "mac/arm64/unphased.uxpaddon"]) {
    if (fs.existsSync(path.join(ROOT, p))) { copy(p); addons++; }
}
if (!addons) {
    console.error("build-ccx: no native addon found under win/ or mac/ — the panel would load but " +
        "could not decode anything. Build it first (see native/README.md).");
    process.exit(1);
}

// Zip the STAGE CONTENTS (manifest.json at archive root) → .ccx. Entry names use
// forward slashes per the zip spec — Compress-Archive writes backslashes, which
// breaks extraction on non-Windows tooling, so drive System.IO directly.
fs.rmSync(OUT, { force: true });
if (process.platform === "win32") {
    execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem; ` +
        `$zip = [System.IO.Compression.ZipFile]::Open("${OUT}", [System.IO.Compression.ZipArchiveMode]::Create); ` +
        `Get-ChildItem -Path "${STAGE}" -Recurse -File | ForEach-Object { ` +
        `  $rel = $_.FullName.Substring("${STAGE}".Length + 1).Replace('\\', '/'); ` +
        `  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) ` +
        `}; $zip.Dispose()`
    ], { stdio: "inherit" });
} else {
    execFileSync("zip", ["-r", "-q", OUT, "."], { cwd: STAGE, stdio: "inherit" });
}
fs.rmSync(STAGE, { recursive: true, force: true });

const bytes = fs.statSync(OUT).size;
console.log(`build-ccx: ${path.relative(ROOT, OUT)} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${addons} addon(s))`);
if (bytes > 15 * 1024 * 1024) {
    console.error("build-ccx: package is unexpectedly large — check the staged contents.");
    process.exit(1);
}
