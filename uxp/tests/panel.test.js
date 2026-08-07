// Static consistency checks for the UXP panel — the same class of guard the CEP
// panel has in engine/test/panel.test.js. These catch the failure that looks
// exactly like "the button does nothing": a DOM id main.js reaches for that no
// longer exists in index.html, a script that never loads, or a packaging list
// that has drifted from what is on disk.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const html = read("index.html");
const mainJs = read("js/main.js");
const css = read("css/panel.css");
const manifest = JSON.parse(read("manifest.json"));
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

test("every element main.js looks up exists in index.html", () => {
    const wanted = new Set([
        ...[...mainJs.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]),
        ...[...mainJs.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1])
    ]);
    const missing = [...wanted].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `main.js reaches for ids that index.html does not define`);
});

test("every script index.html loads exists on disk", () => {
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, "index.html loads no scripts");
    for (const rel of scripts) {
        assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing script ${rel}`);
    }
});

test("every stylesheet index.html links exists on disk", () => {
    const sheets = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(sheets.length >= 1, "index.html links no stylesheet");
    for (const rel of sheets) {
        assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing stylesheet ${rel}`);
    }
});

test("every font the stylesheet references is bundled", () => {
    // Fonts are bundled deliberately so the panel renders identically offline;
    // a missing file silently falls back to a system font.
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(urls.length >= 6, "expected the six IBM Plex faces");
    for (const rel of urls) {
        assert.ok(fs.existsSync(path.join(ROOT, "css", rel)), `missing font ${rel}`);
    }
});

test("the version in the footer matches the manifest and package.json", () => {
    const footer = html.match(/Unphased UXP v([\d.]+)/);
    assert.ok(footer, "footer has no version string");
    assert.equal(footer[1], manifest.version, "footer version != manifest version");
    assert.equal(JSON.parse(read("package.json")).version, manifest.version,
        "package.json version != manifest version");
    const reported = mainJs.includes("premiere") && read("js/premiere.js").match(/version:\s*"([\d.]+)"/);
    assert.ok(reported, "premiere.js ping() reports no version");
    assert.equal(reported[1], manifest.version, "ping() version != manifest version");
});

test("the CEP and UXP plugins are at the same version", () => {
    // Both ship off one tag; CI enforces this too, but failing here is quicker.
    const cep = fs.readFileSync(path.resolve(ROOT, "..", "cep", "VERSION"), "utf8").trim();
    assert.equal(cep, manifest.version, "cep/VERSION != uxp/manifest.json version");
});

test("the manifest declares what a hybrid plugin needs", () => {
    assert.equal(manifest.host.app, "premierepro");
    // Hybrid addons are unsupported before 26.0 — Premiere 25.x loads the panel
    // and then reports "Addon is not supported", which reads as a plugin bug.
    assert.ok(parseFloat(manifest.host.minVersion) >= 26, "minVersion must be 26.0+ for a hybrid addon");
    assert.equal(manifest.addon.name, "unphased.uxpaddon");
    assert.equal(manifest.requiredPermissions.enableAddon, true);
    assert.equal(manifest.requiredPermissions.localFileSystem, "fullAccess");
    // An array host is the UXP-devtools dev-loop format; using it in a packaged
    // build causes a generic "Couldn't install plugin" failure.
    assert.ok(!Array.isArray(manifest.host), "manifest.host must be a single object, not an array");
});

test("every runtime file build-ccx stages exists", () => {
    const build = read("scripts/build-ccx.js");
    const singles = [...build.matchAll(/copy\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const rel of singles) {
        assert.ok(fs.existsSync(path.join(ROOT, rel)), `build-ccx stages missing file ${rel}`);
    }
    for (const f of ["main.js", "audio.js", "runner.js", "premiere.js", "pairing.js"]) {
        assert.ok(fs.existsSync(path.join(ROOT, "js", f)), `missing js/${f}`);
    }
});

test("the segmented controls offer the values readParams understands", () => {
    const values = (id) => {
        const block = new RegExp(`id="${id}"[\\s\\S]*?</div>\\s*</div>`).exec(html);
        assert.ok(block, `no ${id} segment in index.html`);
        return [...block[0].matchAll(/data-value="([^"]+)"/g)].map((m) => m[1]);
    };
    assert.deepEqual(values("param-mode"), ["dynamic", "static"]);
    assert.deepEqual(values("param-phase"), ["spectral", "static", "off"]);
    // Exactly one option per segment starts selected.
    for (const id of ["param-mode", "param-phase"]) {
        const block = new RegExp(`id="${id}"[\\s\\S]*?</div>\\s*</div>`).exec(html)[0];
        assert.equal((block.match(/seg-opt is-on/g) || []).length, 1, `${id} needs exactly one default`);
    }
});

test("whole-sequence mode is gone — there is no scope toggle left to forget to set", () => {
    // Unphased used to offer a Scope toggle between "whole sequence" and
    // "selected clips only". It was removed in favour of always aligning
    // whatever is selected — one control (REF) and one live-updating status
    // note replace a toggle, a per-track TGT tick, and the trap of leaving
    // scope on the wrong setting.
    for (const gone of ['id="param-scope"', 'id="btn-scope"', "pill-tgt"]) {
        assert.ok(!html.includes(gone), `${gone} should be gone from index.html`);
    }
    for (const gone of ["state.targetTracks", "seedTargets", "selectedOnly()", "state.params.scope"]) {
        assert.ok(!mainJs.includes(gone), `${gone} should be gone from main.js`);
    }
    assert.match(mainJs, /selectedOnly:\s*true/,
        "pairing.buildPairs must always be called with selectedOnly: true now");
});

test("the active sequence is picked up automatically, not just at boot", () => {
    // project.getActiveSequence() is unreliable in the first moment a panel
    // loads, and Premiere pushes no event when the user switches sequences
    // later. Both are covered by polling a cheap name-only read and re-scanning
    // when it changes — catch a regression back to the original one-shot boot
    // call, which silently stopped auto-detecting a sequence that became active
    // after the panel had already given up.
    const premiereJs = fs.readFileSync(path.join(ROOT, "js", "premiere.js"), "utf8");
    assert.match(premiereJs, /async function getActiveSequenceName\(\)/,
        "premiere.js needs a cheap, non-throwing active-sequence-name read for the poll");
    assert.match(premiereJs, /getActiveSequenceName,?\s*\n/,
        "getActiveSequenceName must be exported for main.js to poll it");

    assert.match(mainJs, /async function pollActiveSequence\(\)/,
        "main.js must poll for the active sequence changing");
    assert.match(mainJs, /setInterval\(\s*\(\)\s*=>\s*\{\s*guard\(pollActiveSequence\)\(\)/,
        "the poll must actually be started");
    assert.match(mainJs, /premiere\.getActiveSequenceName\(\)/, "the poll must call the cheap read, not a full scan");
    // The initial boot scan must stay quiet on "no sequence yet" — the poll
    // resolves it within a couple of seconds, so a red error at boot for a
    // race that self-heals reads as a bug that isn't one.
    assert.match(mainJs, /guard\(refresh\)\(\{\s*quiet:\s*true\s*\}\)/,
        "the boot-time scan must pass quiet:true");
});

test("spacing does not rely on flex gap, which UXP ignores", () => {
    // UXP honours neither row nor column `gap`. Every gapped container needs a
    // margin rule doing the real work, or the panel renders flush — which is
    // exactly how the first build looked. These are the containers that matter;
    // if you remove one, say why.
    const required = [
        ".body > * + *",          // the 12px between major blocks
        ".body > * { flex-shrink: 0; }", // stops UXP squashing blocks on overflow
        ".btn-row > * + *",       // just Align now, but keep the rule for the next button it gains
        ".track-row > * + *",     // REF / name / live badge / meta / source chip
        ".param-field + .param-field", // Time / Phase columns
        ".head-tools > * + *",
        ".footer > * + *",
        ".settings-body > * + *",
        ".instructions-body > * + *",
        ".ins-section > * + *",
        ".ins-range-row + .ins-range-row"
    ];
    for (const rule of required) {
        assert.ok(css.includes(rule), `css/panel.css lost its margin fallback: ${rule}`);
    }
    // Row children that carry their own separation.
    for (const decl of [".header-icon", ".btn-header-icon", ".busy-spinner", ".ins-tag"]) {
        const block = new RegExp(`\\${decl}\\s*\\{[^}]*margin-(left|right)`).test(css);
        assert.ok(block, `${decl} needs a horizontal margin — UXP drops the row gap`);
    }
});

test("no CEP-only or UXP-unsupported markup crept into index.html", () => {
    // UXP's native <button> ignores author backgrounds; <select>/<details> and
    // checkbox/radio inputs are avoided on purpose (see css/panel.css header).
    for (const tag of ["<button", "<select", "<details", "<summary", 'type="checkbox"', 'type="radio"']) {
        assert.ok(!html.includes(tag), `index.html uses ${tag}, which this port deliberately avoids`);
    }
    assert.ok(!/\shidden(\s|>|=)/.test(html),
        "use style=\"display:none\" rather than the hidden attribute");
});
