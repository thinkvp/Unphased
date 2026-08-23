#!/usr/bin/env node
/**
 * set-version.js — single-source version bumper.
 * Usage: node scripts/set-version.js 0.3.0
 *
 * Updates manifest.json, package.json, the index.html footer and the version
 * premiere.js reports from ping(), so the number can never drift between them.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("-"));

if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    console.error("Usage: node scripts/set-version.js <major.minor.patch>");
    process.exit(1);
}

function edit(base, rel, fn) {
    const file = path.join(base, rel);
    const before = fs.readFileSync(file, "utf8");
    const after = fn(before);
    if (before === after) {
        console.error(`set-version: NO CHANGE in ${rel} — pattern not found?`);
        process.exit(1);
    }
    fs.writeFileSync(file, after);
    console.log(`set-version: ${rel} → ${version}`);
}

edit(ROOT, "manifest.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit(ROOT, "package.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit(ROOT, "index.html", (s) => s.replace(/Unphased UXP v[\d.]+/, `Unphased UXP v${version}`));
edit(ROOT, "js/premiere.js", (s) => s.replace(/(version:\s*")[\d.]+(")/, `$1${version}$2`));

console.log("set-version: done.");
