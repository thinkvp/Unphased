// Unphased — ExtendScript host layer. ES3 only. Every entry point returns a
// JSON string with { ok: ... } and catches everything: there is no usable
// console on this side, so errors must travel through the return value.
// json2.jsx must be evaluated before this file.

var UNPHASED_TICKS_PER_SECOND = 254016000000;

function AA__wrap(fn) {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e), line: (e && e.line) ? e.line : -1 });
  }
}

function AA_ping() {
  return AA__wrap(function () {
    return {
      ok: true,
      version: '0.2.0',
      appVersion: app.version,
      project: app.project ? app.project.name : null,
      hasActiveSequence: !!(app.project && app.project.activeSequence)
    };
  });
}

/**
 * Where the project lives on disk, so rendered audio can be written beside it
 * rather than into a temp folder Windows is free to delete. `path` is empty on
 * a project that has never been saved.
 */
function AA_getProjectInfo() {
  return AA__wrap(function () {
    if (!app.project) return { ok: false, error: 'No project open' };
    var p = '';
    try { p = String(app.project.path || ''); } catch (e) {}
    return { ok: true, name: String(app.project.name), path: p || null };
  });
}

/**
 * Light read for the idle poll: active sequence's name (or null), no
 * track/clip enumeration. project.activeSequence is unreliable right when a
 * panel first loads, and nothing fires when the user switches sequences
 * later — both are covered by re-checking this periodically and letting the
 * caller re-read the full sequence when it changes.
 */
function AA_getActiveSequenceName() {
  return AA__wrap(function () {
    var seq = app.project ? app.project.activeSequence : null;
    return { ok: true, name: seq ? String(seq.name) : null };
  });
}

/**
 * Node ids of the timeline selection, as { nodeId: true }.
 *
 * seq.getSelection() is the reliable route: per-clip isSelected() is missing on
 * some builds and reports stale state on others. Matching is by nodeId only —
 * matching on start time would false-positive across tracks, which is exactly
 * the multi-mic case this panel exists for.
 * @returns {{ map: object, count: number, method: string }}
 */
function AA__selectionMap(seq) {
  var map = {};
  var count = 0;
  try {
    var sel = seq.getSelection();
    if (sel) {
      for (var i = 0; i < sel.length; i++) {
        var id = null;
        try { id = String(sel[i].nodeId); } catch (eI) {}
        if (id) { map[id] = true; count++; }
      }
      return { map: map, count: count, method: 'getSelection' };
    }
  } catch (e) {}
  return { map: map, count: 0, method: 'per-clip' };
}

function AA__clipInfo(clip, trackIndex, clipIndex, selection) {
  var info = {
    trackIndex: trackIndex,
    clipIndex: clipIndex,
    name: '',
    nodeId: null,
    mediaPath: null,
    startSeconds: null,
    startTicks: null,
    endSeconds: null,
    inPointSeconds: null,
    outPointSeconds: null,
    disabled: false,
    speedFactor: 1,
    channelCount: null,
    selected: false
  };
  try { info.name = String(clip.name); } catch (e1) {}
  try { info.nodeId = String(clip.nodeId); } catch (e2) {}
  try { info.mediaPath = clip.projectItem ? String(clip.projectItem.getMediaPath()) : null; } catch (e3) {}
  try { info.startSeconds = clip.start.seconds; info.startTicks = String(clip.start.ticks); } catch (e4) {}
  try { info.endSeconds = clip.end.seconds; } catch (e5) {}
  try { info.inPointSeconds = clip.inPoint.seconds; } catch (e6) {}
  try { info.outPointSeconds = clip.outPoint.seconds; } catch (e7) {}
  try { info.disabled = !!clip.disabled; } catch (e8) {}
  try { info.speedFactor = clip.getSpeed(); } catch (e9) {}
  if (selection && selection.method === 'getSelection') {
    info.selected = info.nodeId !== null && !!selection.map[info.nodeId];
  } else {
    // No getSelection() on this build — fall back to asking the clip itself.
    try {
      if (typeof clip.isSelected === 'function') info.selected = !!clip.isSelected();
      else if (clip.selected !== undefined) info.selected = !!clip.selected;
    } catch (e10) {}
  }
  if (info.nodeId === null) {
    info.nodeId = 't' + trackIndex + 'c' + clipIndex + '@' + info.startTicks;
  }
  return info;
}

function AA_getSequenceInfo() {
  return AA__wrap(function () {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return { ok: false, error: 'No active sequence. Open a sequence and press Refresh.' };
    var selection = AA__selectionMap(seq);
    var tracks = [];
    var selectedClips = 0;
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      var tr = seq.audioTracks[i];
      var clips = [];
      for (var j = 0; j < tr.clips.numItems; j++) {
        var ci = AA__clipInfo(tr.clips[j], i, j, selection);
        if (ci.selected) selectedClips++;
        clips.push(ci);
      }
      var trackName = 'A' + (i + 1);
      try { if (tr.name) trackName = String(tr.name); } catch (eN) {}
      var muted = false;
      try { muted = tr.isMuted(); } catch (eM) {}
      tracks.push({ index: i, name: trackName, muted: muted, clipCount: clips.length, clips: clips });
    }
    var sampleRate = null;
    try { sampleRate = seq.getSettings().audioSampleRate.seconds; } catch (eS) {}
    return {
      ok: true,
      sequence: { name: String(seq.name), timebase: String(seq.timebase) },
      sampleRate: sampleRate,
      audioTracks: tracks,
      // How selection was read and what it saw, so "nothing is selected" can be
      // told apart from "this build reports selection differently".
      selection: {
        method: selection.method,
        reportedByHost: selection.count,
        matchedOnAudioTracks: selectedClips
      }
    };
  });
}

/**
 * Selection only, for the panel's live track badges — no timing, no media
 * paths, just a per-clip nodeId check against AA__selectionMap(). Same
 * per-clip cost as AA_getSequenceInfo()'s clip loop, but skipping every
 * other field keeps the JSON small enough to poll every second or two while
 * the panel is open, so the track list can track the timeline selection
 * without a full Refresh.
 */
function AA_getSelectionOnly() {
  return AA__wrap(function () {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return { ok: false, error: 'No active sequence' };
    var selection = AA__selectionMap(seq);
    var audioTracks = [];
    var matched = 0;
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      var tr = seq.audioTracks[i];
      var n = 0;
      for (var j = 0; j < tr.clips.numItems; j++) {
        var clip = tr.clips[j];
        var isSel = false;
        if (selection.method === 'getSelection') {
          var id = null;
          try { id = String(clip.nodeId); } catch (eI) {}
          isSel = id !== null && !!selection.map[id];
        } else {
          try {
            if (typeof clip.isSelected === 'function') isSel = !!clip.isSelected();
            else if (clip.selected !== undefined) isSel = !!clip.selected;
          } catch (eS) {}
        }
        if (isSel) n++;
      }
      matched += n;
      audioTracks.push({ index: i, selectedClipCount: n });
    }
    return {
      ok: true,
      audioTracks: audioTracks,
      reportedByHost: selection.method === 'getSelection' ? selection.count : matched,
      matchedOnAudioTracks: matched
    };
  });
}

function AA__findBin(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var child = root.children[i];
    try {
      if (child.name === name && child.type === ProjectItemType.BIN) return child;
    } catch (e) {}
  }
  return root.createBin(name);
}

function AA__findInBin(bin, fileName) {
  var base = fileName.replace(/\.[^\.]+$/, '');
  for (var i = 0; i < bin.children.numItems; i++) {
    var child = bin.children[i];
    var n = '';
    try { n = String(child.name); } catch (e) {}
    if (n === fileName || n === base) return child;
  }
  return null;
}

function AA__findClipByNodeId(seq, nodeId) {
  for (var i = 0; i < seq.audioTracks.numTracks; i++) {
    var tr = seq.audioTracks[i];
    for (var j = 0; j < tr.clips.numItems; j++) {
      var c = tr.clips[j];
      var id = null;
      try { id = String(c.nodeId); } catch (e) {}
      if (id !== null && id === nodeId) return c;
    }
  }
  return null;
}

/**
 * payload: { items: [{ id, path, fileName, trackIndex, startSeconds, muteNodeId }] }
 */
function AA_importAndPlace(payloadJson) {
  return AA__wrap(function () {
    var payload = JSON.parse(payloadJson);
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return { ok: false, error: 'No active sequence' };
    var bin = AA__findBin('Unphased');
    var paths = [];
    var i;
    for (i = 0; i < payload.items.length; i++) paths.push(payload.items[i].path);
    app.project.importFiles(paths, true, bin, false);

    var results = [];
    for (i = 0; i < payload.items.length; i++) {
      var item = payload.items[i];
      var res = { id: item.id, ok: false, error: null };
      try {
        var pi = AA__findInBin(bin, item.fileName);
        if (!pi) {
          res.error = 'imported item not found in bin: ' + item.fileName;
        } else if (item.trackIndex >= seq.audioTracks.numTracks) {
          res.error = 'track index ' + item.trackIndex + ' out of range';
        } else {
          seq.audioTracks[item.trackIndex].overwriteClip(pi, item.startSeconds);
          if (item.muteNodeId) {
            var orig = AA__findClipByNodeId(seq, item.muteNodeId);
            if (orig) {
              try { orig.disabled = true; } catch (eD) { res.muteError = String(eD); }
            } else {
              res.muteError = 'original clip not found for mute';
            }
          }
          res.ok = true;
        }
      } catch (e) {
        res.error = String(e);
      }
      results.push(res);
    }
    return { ok: true, results: results };
  });
}

/** arg: { total: <desired total audio track count> } */
function AA_ensureTracks(argJson) {
  return AA__wrap(function () {
    var arg = JSON.parse(argJson);
    var seq = app.project.activeSequence;
    if (!seq) return { ok: false, error: 'No active sequence' };
    var have = seq.audioTracks.numTracks;
    if (have >= arg.total) return { ok: true, added: 0, numTracks: have };
    var toAdd = arg.total - have;

    // QE DOM is undocumented; try known addTracks signatures and verify.
    try {
      app.enableQE();
      var qeSeq = qe.project.getActiveSequence();
      try { qeSeq.addTracks(0, 0, toAdd, 0, have, 0); } catch (e1) {
        try { qeSeq.addTracks(0, 0, toAdd); } catch (e2) {}
      }
    } catch (e0) {}

    var now = app.project.activeSequence.audioTracks.numTracks;
    if (now >= arg.total) return { ok: true, added: now - have, numTracks: now };
    return {
      ok: false,
      numTracks: now,
      error: 'Could not add tracks automatically. Add ' + toAdd +
        ' audio track(s) via Sequence > Add Tracks..., then run Align again.'
    };
  });
}
