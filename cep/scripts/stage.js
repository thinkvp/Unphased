#!/usr/bin/env node
/**
 * stage.js — assemble the shippable CEP extension in cep/dist/staging/.
 *
 * One include list, so the installer can never drift from what the panel
 * actually loads. `installer/unphased-cep-installer.iss` points Inno Setup at
 * the staged tree directly.
 *
 * The thing that makes this different from an ordinary CEP extension: the DSP
 * runs in a separate system-Node process, so `engine/` has to travel with the
 * panel. In the repo it sits beside cep/ and the junction install reaches it as
 * a sibling; an installed panel has no such sibling, and the CEP extensions
 * directory is scanned for extensions, so dropping a bare engine/ next to the
 * extension folder is not an option. It goes INSIDE instead, and
 * js/jobRunner.js looks there first.
 *
 * Usage: node scripts/stage.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "..");
const DIST = path.join(ROOT, "dist");
const STAGING = path.join(DIST, "staging");

// Runtime files from cep/. Everything else in the folder is development-only:
// scripts/ (this file, install-panel.ps1), installer/, .debug (the CEF remote
// debugging ports — shipping it would expose them on every user's machine).
const INCLUDE = ["CSXS", "css", "js", "jsx", "fonts", "index.html", "README.md", "VERSION"];

// From the repo root. The engine is pure Node with no dependencies, so this is
// just its source: cli.js, worker.js and src/. Its tests and bench are not
// runtime files.
const ENGINE_INCLUDE = ["cli.js", "worker.js", "package.json", "src"];

function copy(src, dest, what) {
    if (!fs.existsSync(src)) {
        console.error(`stage: MISSING ${what} — expected at ${src}`);
        process.exit(1);
    }
    fs.cpSync(src, dest, { recursive: true });
}

function stage() {
    fs.rmSync(STAGING, { recursive: true, force: true });
    fs.mkdirSync(STAGING, { recursive: true });

    for (const entry of INCLUDE) {
        copy(path.join(ROOT, entry), path.join(STAGING, entry), `cep/${entry}`);
    }

    const engineOut = path.join(STAGING, "engine");
    fs.mkdirSync(engineOut, { recursive: true });
    for (const entry of ENGINE_INCLUDE) {
        copy(path.join(REPO, "engine", entry), path.join(engineOut, entry), `engine/${entry}`);
    }

    // The licence has to ship: the panel is MIT and the bundled IBM Plex faces
    // are OFL.
    copy(path.join(REPO, "LICENSE"), path.join(STAGING, "LICENSE"), "LICENSE");

    // Belt and braces — the panel is dead without this, and the failure mode is
    // a runtime "Engine not found" on the user's machine rather than a build error.
    const cli = path.join(engineOut, "cli.js");
    if (!fs.existsSync(cli)) {
        console.error("stage: engine/cli.js did not make it into the staged tree");
        process.exit(1);
    }
    return STAGING;
}

if (require.main === module) {
    const out = stage();
    const count = fs.readdirSync(out).length;
    console.log(`stage: ${count} top-level entries staged at ${path.relative(REPO, out)}`);
}

module.exports = { stage, ROOT, REPO, DIST, STAGING, INCLUDE, ENGINE_INCLUDE };
