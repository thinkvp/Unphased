#!/usr/bin/env node
/**
 * check-syntax.js — zero-dependency syntax gate.
 * Compiles each JS file with the V8 parser (node:vm) to catch syntax errors
 * without executing it, so require("premierepro"), document, etc. are fine.
 *
 * Covers the hand-written plugin sources plus every generated engine module —
 * a bad transpile should fail here rather than inside Premiere.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const FILES = [
    "js/audio.js",
    "js/runner.js",
    "js/premiere.js",
    "js/pairing.js",
    "js/main.js",
    "scripts/build-engine.js",
    "scripts/build-ccx.js",
    "scripts/set-version.js",
    "scripts/check-syntax.js",
];
for (const f of fs.readdirSync(path.join(ROOT, "js", "engine")).sort()) {
    FILES.push(`js/engine/${f}`);
}
for (const f of fs.readdirSync(path.join(ROOT, "tests")).sort()) {
    if (f.endsWith(".js")) FILES.push(`tests/${f}`);
}

let failed = 0;
for (const rel of FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) { console.error(`check-syntax: MISSING ${rel}`); failed++; continue; }
    try {
        new vm.Script(fs.readFileSync(file, "utf8"), { filename: rel });
    } catch (e) {
        console.error(`check-syntax: FAIL ${rel} — ${e.message}`);
        failed++;
    }
}
if (failed) { console.error(`check-syntax: ${failed} file(s) failed.`); process.exit(1); }
console.log(`check-syntax: all ${FILES.length} files parse.`);
