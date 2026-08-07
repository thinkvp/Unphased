// Panel orchestration: scan sequence -> pick tracks -> build pairs ->
// ensure tracks -> run engine -> import & place -> report.

(function () {
  var state = {
    seqInfo: null,
    refTrack: null,
    running: false,
    probe: {},        // mediaPath -> { streams: [{index, channels}] }
    sourceMap: {},    // trackIndex -> { audioStream, channel }
    sourceOverrides: {},
    showSources: false, // source pickers stay closed until asked for
    projectPath: null,
    renderDir: null,
    // No targetTracks: every non-reference track with a live-selected clip is
    // a target automatically. Whole-sequence mode is gone — Unphased only
    // ever aligns what is selected in the timeline.
    liveSelection: null,         // trackIndex -> selected clip count, kept fresh by pollSelection()
    liveSelectionReported: null, // last AA_getSelectionOnly() reportedByHost, for the "video not audio" hint
    lastLiveSeqName: undefined,  // undefined = not polled yet; null = polled, none active
    polling: false,
    pollingSelection: false
  };

  var $ = function (id) { return document.getElementById(id); };

  // ─── Log ───────────────────────────────────────────────────────────────────
  function log(msg, type) {
    var el = $('log');
    var entry = document.createElement('div');
    entry.className = 'log-entry log-' + (type || 'info');
    var d = new Date();
    var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) +
      ':' + ('0' + d.getSeconds()).slice(-2);
    entry.textContent = '[' + ts + '] ' + msg;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
  }

  // ─── Busy / progress ───────────────────────────────────────────────────────
  function setBusy(text, cancellable) {
    if (text) {
      $('busy-text').textContent = text;
      $('busy-row').hidden = false;
      $('btn-cancel').hidden = !cancellable;
      $('btn-cancel').disabled = false;
    } else {
      $('busy-row').hidden = true;
    }
  }

  function setProgress(pct, visible) {
    $('progress-wrap').style.display = visible === false ? 'none' : 'block';
    $('progress-bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function setSeqInfo(html) { $('seq-info').innerHTML = html; }

  // Compact local timestamp, used to keep each run's rendered files distinct.
  function stamp() {
    var d = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────────────
  function bindSetting(inputId, key) {
    var el = $(inputId);
    el.value = localStorage.getItem(key) || '';
    el.addEventListener('change', function () {
      if (el.value.trim()) localStorage.setItem(key, el.value.trim());
      else localStorage.removeItem(key);
      renderToolStatus();
    });
  }

  function renderToolStatus() {
    var st = window.UnphasedJobRunner.toolStatus();
    function chip(name, value, hint) {
      if (value) {
        return '<span class="tool-chip tool-ok" title="' + escapeHtml(value) + '">' + name + ' ✓</span>';
      }
      return '<span class="tool-chip tool-missing" title="' + escapeHtml(hint) + '">' + name + ' ✗</span>';
    }
    $('tool-status').innerHTML =
      chip('node', st.node, 'Node.js not found — set node.exe in Settings') + ' ' +
      chip('ffmpeg', st.ffmpeg, 'ffmpeg not found — set its path in Settings') + ' ' +
      chip('engine', st.engine, 'engine/cli.js not found — set its path in Settings');
    return st;
  }

  // ─── Track list ────────────────────────────────────────────────────────────
  function channelOptionsFor(track) {
    var path = null;
    for (var c = 0; c < track.clips.length; c++) {
      if (track.clips[c].mediaPath) { path = track.clips[c].mediaPath; break; }
    }
    var probe = path && state.probe[path];
    var streams = (probe && probe.streams) || [];
    var opts = [];
    if (streams.length > 1) {
      for (var s = 0; s < streams.length; s++) {
        if (streams[s].channels > 1) {
          for (var ch = 0; ch < streams[s].channels; ch++) {
            opts.push({ value: s + ':' + ch, label: 'src ' + (s + 1) + '.' + (ch + 1) });
          }
        } else {
          opts.push({ value: s + ':null', label: 'src ' + (s + 1) });
        }
      }
    } else if (streams.length === 1 && streams[0].channels > 1) {
      var n = streams[0].channels;
      // "stereo" first — it is the default for a file only one track uses, and
      // the only option that keeps every channel through to the render.
      opts.push({ value: '0:null', label: n === 2 ? 'stereo' : 'all ' + n + ' ch' });
      for (var ch2 = 0; ch2 < n; ch2++) {
        opts.push({ value: '0:' + ch2, label: channelName(ch2, n) });
      }
    }
    return opts;
  }

  // A 2-channel file is either a stereo mic or two mics interleaved; either
  // way channel 0 is the left one, so name it that. Beyond stereo the
  // positional names stop being reliable, so fall back to numbers.
  function channelName(index, total) {
    if (total === 2) return index === 0 ? 'left' : 'right';
    return 'ch ' + (index + 1);
  }

  // Where the current selection actually sits: on the reference track (inert
  // — the reference is never filtered by selection) or on some other track
  // (a target, automatically — no separate TGT tick to set). Reads
  // state.liveSelection when the poll has filled it in — kept fresh every
  // couple of seconds while the panel is open — and falls back to the
  // selection baked into the last Refresh for the moment before the first
  // poll tick lands.
  function selectionTally() {
    var tracks = state.seqInfo ? state.seqInfo.audioTracks : [];
    var live = state.liveSelection;
    var t = { onTargets: 0, onRef: 0, targetTrackCount: 0 };
    for (var i = 0; i < tracks.length; i++) {
      var n;
      if (live) {
        n = live[tracks[i].index] || 0;
      } else {
        n = 0;
        for (var c = 0; c < tracks[i].clips.length; c++) {
          if (tracks[i].clips[c].selected) n++;
        }
      }
      if (!n) continue;
      if (tracks[i].index === state.refTrack) t.onRef += n;
      else { t.onTargets += n; t.targetTrackCount++; }
    }
    return t;
  }

  // What Align will actually do, live — no Refresh required. Just clicking
  // around the timeline re-tallies on the next poll tick. Must never just
  // say "nothing selected" — a selection sitting on the reference track is a
  // different problem with a different fix than no selection at all.
  function updateAlignNote() {
    var note = $('align-note');
    if (!state.seqInfo) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    var warn = true;
    var msg;
    var t = selectionTally();
    if (state.refTrack === null) {
      msg = 'Pick a reference track below, then select the clips you want aligned in the timeline.';
    } else if (t.onTargets) {
      msg = t.onTargets + ' selected clip(s) across ' + t.targetTrackCount + ' track(s) will be aligned.';
      warn = false;
    } else if (t.onRef) {
      msg = t.onRef + ' selected clip(s) are on the reference track, which is the yardstick — ' +
        'select clips on another track instead.';
    } else {
      var reported = state.liveSelection ? state.liveSelectionReported :
        ((state.seqInfo.selection || {}).reportedByHost);
      msg = 'No clips selected in the timeline — select the clips you want aligned.';
      // The host saw a selection we could not place on an audio track: video-only
      // selection, or a build whose ids do not line up. Say so rather than
      // insisting nothing is selected.
      if (reported > 0) {
        msg = 'Premiere reports ' + reported + ' selected item(s), but none of them are ' +
          'audio clips on this sequence\'s audio tracks — select the audio, not just the video.';
      }
    }
    note.textContent = msg;
    note.className = 'param-note' + (warn ? ' param-note-warn' : '');
  }

  // A radio input is the whole "dropdown": one REF pill per track, mutually
  // exclusive by name, so picking a reference is a single click on the row
  // that should be it.
  function makeRefPill(checked, disabled, onChange) {
    var label = document.createElement('label');
    label.className = 'pill';
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'reftrack';
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', onChange);
    var span = document.createElement('span');
    span.textContent = 'REF';
    label.appendChild(input);
    label.appendChild(span);
    return label;
  }

  // The Sources button only earns its place when some track actually offers a
  // choice; with plain single-stream mono files there is nothing to reveal.
  function updateSourcesToggle(anyOptions) {
    var btn = $('btn-sources');
    if (anyOptions !== undefined) btn.hidden = !anyOptions;
    btn.className = 'btn-mini' + (state.showSources ? ' is-on' : '');
    $('tracks').className = state.showSources ? 'show-sources' : '';
  }

  function renderTracks() {
    var host = $('tracks');
    host.innerHTML = '';
    var tracks = state.seqInfo ? state.seqInfo.audioTracks : [];
    $('tracks-empty').hidden = tracks.length > 0;
    var anyOptions = false;
    if (!tracks.length) {
      updateSourcesToggle(false);
      return;
    }

    for (var i = 0; i < tracks.length; i++) {
      (function (track) {
        var row = document.createElement('div');
        row.className = 'track-row' +
          (state.refTrack === track.index ? ' is-ref' : '') +
          (track.clipCount === 0 ? ' track-empty' : '');

        row.appendChild(makeRefPill(state.refTrack === track.index, track.clipCount === 0, function () {
          state.refTrack = track.index;
          renderTracks();
          updateAlignButton();
        }));

        var name = document.createElement('span');
        name.className = 'track-name';
        name.textContent = track.name;
        name.title = track.name;
        row.appendChild(name);

        var isRef = state.refTrack === track.index;
        var live = state.liveSelection;
        var selectedCount = live ? (live[track.index] || 0) : (function () {
          var n = 0;
          for (var c = 0; c < track.clips.length; c++) { if (track.clips[c].selected) n++; }
          return n;
        })();
        var badge = document.createElement('span');
        badge.className = 'track-live' + (selectedCount > 0 ? (isRef ? ' is-ref-live' : ' is-target') : '');
        badge.title = isRef
          ? 'The reference track is never filtered by selection — it supplies material wherever it overlaps a target.'
          : (selectedCount > 0 ? 'This track becomes a target automatically because it has a selected clip.'
            : 'No clips selected on this track — select some in the timeline to make it a target.');
        badge.textContent = selectedCount > 0 ? (selectedCount + ' selected') : '—';
        row.appendChild(badge);

        var meta = document.createElement('span');
        meta.className = 'track-meta';
        meta.textContent = track.clipCount + (track.clipCount === 1 ? ' clip' : ' clips');
        row.appendChild(meta);

        // Source picker, shown only when the media offers a choice. Premiere's
        // API can't say which channel a clip uses, so this is a heuristic
        // default the user can correct.
        var opts = channelOptionsFor(track);
        if (opts.length > 1) {
          anyOptions = true;
          var sel = document.createElement('select');
          sel.className = 'chansel';
          sel.title = 'Which source channel this track plays';
          var cur = state.sourceMap[track.index] || { audioStream: 0, channel: null };
          for (var o = 0; o < opts.length; o++) {
            var opt = document.createElement('option');
            opt.value = opts[o].value;
            opt.textContent = opts[o].label;
            if (opts[o].value === (cur.audioStream + ':' + cur.channel)) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', function () {
            var parts = sel.value.split(':');
            state.sourceOverrides[track.index] = {
              audioStream: parseInt(parts[0], 10),
              channel: parts[1] === 'null' ? null : parseInt(parts[1], 10)
            };
            state.sourceMap[track.index] = state.sourceOverrides[track.index];
            log('Track "' + track.name + '" source set to ' + sel.options[sel.selectedIndex].textContent);
          });
          row.appendChild(sel);
        }
        host.appendChild(row);
      })(tracks[i]);
    }
    updateSourcesToggle(anyOptions);
  }

  function updateAlignButton() {
    var t = selectionTally();
    $('btn-align').disabled =
      state.running || state.refTrack === null || t.onTargets === 0 || !state.seqInfo;
    updateAlignNote();
  }

  // ─── Refresh ───────────────────────────────────────────────────────────────
  function refresh(cb, opts) {
    var quiet = !!(opts && opts.quiet);
    setBusy('Reading sequence…');
    // Resolved before every run rather than once at boot: the user can save an
    // untitled project, or Save As onto another volume, between two aligns.
    window.UnphasedBridge.call('AA_getProjectInfo', undefined, function (proj) {
      state.projectPath = (proj && proj.ok && proj.path) || null;
      readSequence(cb, quiet);
    });
  }

  function readSequence(cb, quiet) {
    window.UnphasedBridge.call('AA_getSequenceInfo', undefined, function (res) {
      if (!res.ok) {
        state.seqInfo = null;
        setSeqInfo('<span class="seq-meta">No active sequence</span>');
        setBusy(null);
        if (!quiet) log(res.error || 'Failed to read sequence', 'error');
        renderTracks();
        updateAlignButton();
        cb && cb(false);
        return;
      }
      state.seqInfo = res;
      if (state.refTrack !== null && !res.audioTracks[state.refTrack]) state.refTrack = null;
      // Seed the live selection tally from this scan's own per-clip reads, so
      // the align note is accurate immediately rather than waiting for the
      // next poll tick.
      var liveMap = {};
      for (var lt = 0; lt < res.audioTracks.length; lt++) {
        var n = 0;
        var clipsForTally = res.audioTracks[lt].clips;
        for (var lc = 0; lc < clipsForTally.length; lc++) { if (clipsForTally[lc].selected) n++; }
        liveMap[res.audioTracks[lt].index] = n;
      }
      state.liveSelection = liveMap;
      state.liveSelectionReported = res.selection ? res.selection.reportedByHost : null;

      var clipTotal = 0;
      var paths = [];
      for (var t = 0; t < res.audioTracks.length; t++) {
        var clips = res.audioTracks[t].clips;
        clipTotal += clips.length;
        for (var c = 0; c < clips.length; c++) {
          if (clips[c].mediaPath && paths.indexOf(clips[c].mediaPath) === -1) {
            paths.push(clips[c].mediaPath);
          }
        }
      }
      setSeqInfo(
        '<span class="seq-name">' + escapeHtml(res.sequence.name) + '</span>' +
        '<span class="seq-meta">' + res.audioTracks.length + ' audio tracks · ' +
        clipTotal + ' clips · ' + paths.length + ' source files</span>'
      );

      setBusy('Inspecting media…');
      window.UnphasedJobRunner.probeMedia(paths, localStorage.getItem('unphased.ffmpegPath'))
        .then(function (probe) { state.probe = probe; })
        .catch(function (err) { state.probe = {}; log('Media probe failed: ' + err.message, 'warn'); })
        .then(function () {
          state.sourceMap = window.UnphasedPairing.defaultSourceMap(res, state.probe);
          for (var idx in state.sourceOverrides) {
            if (res.audioTracks[idx]) state.sourceMap[idx] = state.sourceOverrides[idx];
          }
          // Only warn where the assignment is genuinely a guess: several
          // streams, or one multi-channel stream split across several tracks.
          // A stereo file on a single track is just a stereo file.
          var shared = window.UnphasedPairing.tracksPerPath(res);
          var multi = 0;
          for (var p in state.probe) {
            var st = state.probe[p].streams || [];
            if (st.length > 1 || (st.length === 1 && st[0].channels > 1 && shared[p] > 1)) multi++;
          }
          renderTracks();
          updateAlignButton();
          setBusy(null);
          log('Refreshed "' + res.sequence.name + '" — ' + res.audioTracks.length +
            ' tracks, ' + clipTotal + ' clips', 'success');
          if (multi) {
            log(multi + ' source file(s) carry multiple mics — press Sources and check which ' +
              'channel each track is set to', 'warn');
          }
          var sel = res.selection;
          if (sel) {
            log('Selection: ' + sel.matchedOnAudioTracks + ' audio clip(s) selected' +
              ' (host reported ' + sel.reportedByHost + ' item(s) via ' + sel.method + ')',
              sel.reportedByHost && !sel.matchedOnAudioTracks ? 'warn' : 'info');
          }
          cb && cb(true);
        });
    });
  }

  // ─── Params ────────────────────────────────────────────────────────────────
  // Only the two choices an editor can actually answer are sent. Everything
  // else the engine derives: the search window widens on evidence, and
  // polarity, drift agility and band weighting have no setting a user could
  // pick better than the default — a wrong one only degrades the result
  // silently. The engine still accepts them for tests and hand-authored jobs.
  function readParams() {
    var phase = $('param-phase').value;
    return {
      mode: $('param-mode').value,
      phase: phase === 'off' ? 'off' : 'auto',
      // 0 collapses the measurement to a single curve for the whole clip
      phaseBlockSeconds: phase === 'spectral' ? 20 : 0
    };
  }

  // ─── Results ───────────────────────────────────────────────────────────────
  function fmtMs(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }

  function nullBadge(db) {
    if (db === undefined || db === null) return '<span class="badge badge-none">—</span>';
    var v = db.toFixed(0) + ' dB';
    if (db > 40) {
      return '<span class="badge badge-suspect" title="Suspiciously deep — both sides may be decoding the same audio. Check the source dropdowns.">' + v + ' ?</span>';
    }
    if (db >= 10) return '<span class="badge badge-high">' + v + '</span>';
    if (db >= 3) return '<span class="badge badge-mid">' + v + '</span>';
    return '<span class="badge badge-low" title="Little real correlation — treat this result with suspicion.">' + v + '</span>';
  }

  function renderResults(rows) {
    var tbody = $('results').querySelector('tbody');
    tbody.innerHTML = '';
    $('results-section').hidden = rows.length === 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var tr = document.createElement('tr');
      var cells;
      if (r.status === 'failed') {
        cells = [
          { html: escapeHtml(r.label), cls: 'cell-name' },
          { html: '—', cls: 'cell-dim' },
          { html: '—', cls: 'cell-dim' },
          { html: '—', cls: 'cell-dim' },
          { html: '<span class="badge badge-none">—</span>' },
          { html: escapeHtml(r.reason || 'failed'), cls: 'res-bad' }
        ];
      } else {
        var span = r.driftRangeMs ? (r.driftRangeMs[1] - r.driftRangeMs[0]) : 0;
        var statusHtml;
        var statusCls;
        if (r.placed === false) {
          statusHtml = 'place failed'; statusCls = 'res-bad';
        } else if (r.status === 'lowConfidence') {
          statusHtml = 'low confidence'; statusCls = 'res-warn';
        } else {
          statusHtml = r.placed ? 'placed' : 'aligned'; statusCls = 'res-ok';
        }
        cells = [
          { html: escapeHtml(r.label), cls: 'cell-name' },
          { html: fmtMs(r.staticDelayMs), cls: 'cell-num' },
          { html: span > 0.05 ? span.toFixed(1) : '—', cls: span > 0.05 ? 'cell-num' : 'cell-dim' },
          { html: r.polarityInverted ? '<span class="flag" title="Polarity was inverted and has been corrected">inv</span>' : 'ok',
            cls: r.polarityInverted ? '' : 'cell-dim' },
          { html: nullBadge(r.nullDepthDb) },
          { html: statusHtml, cls: statusCls }
        ];
      }
      for (var c = 0; c < cells.length; c++) {
        var td = document.createElement('td');
        td.innerHTML = cells[c].html;
        if (cells[c].cls) td.className = cells[c].cls;
        if (c === 0) td.title = r.label;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderWarnings(warnings) {
    var ul = $('warnings');
    ul.innerHTML = '';
    $('warnings-section').hidden = warnings.length === 0;
    for (var i = 0; i < warnings.length; i++) {
      var li = document.createElement('li');
      li.innerHTML = (warnings[i].clip ? '<span class="warn-clip">' + escapeHtml(warnings[i].clip) + '</span> — ' : '') +
        escapeHtml(warnings[i].reason);
      ul.appendChild(li);
    }
  }

  // ─── Align ─────────────────────────────────────────────────────────────────
  function finish(msg, type) {
    state.running = false;
    updateAlignButton();
    setBusy(null);
    setProgress(0, false);
    if (msg) log(msg, type);
  }

  function runAlign() {
    if (state.running) return;
    refresh(function (okRefresh) {
      if (!okRefresh) return;
      // Targets are derived fresh off this refresh's own selection reads, not
      // the (possibly one poll tick stale) live preview — deterministic at
      // the moment it actually matters.
      var targets = [];
      var refreshedTracks = state.seqInfo.audioTracks;
      for (var rt = 0; rt < refreshedTracks.length; rt++) {
        if (refreshedTracks[rt].index === state.refTrack) continue;
        var hasSelected = false;
        for (var rc = 0; rc < refreshedTracks[rt].clips.length; rc++) {
          if (refreshedTracks[rt].clips[rc].selected) { hasSelected = true; break; }
        }
        if (hasSelected) targets.push(refreshedTracks[rt].index);
      }
      targets.sort(function (a, b) { return a - b; });
      var pr = window.UnphasedPairing.buildPairs(state.seqInfo, state.refTrack, targets, {
        minOverlapSec: 2,
        sourceMap: state.sourceMap,
        selectedOnly: true
      });
      renderWarnings(pr.warnings);
      for (var w = 0; w < pr.warnings.length; w++) {
        log((pr.warnings[w].clip ? pr.warnings[w].clip + ': ' : '') + pr.warnings[w].reason, 'warn');
      }
      if (!pr.pairs.length) {
        log('Nothing to align — see warnings', 'error');
        return;
      }

      state.running = true;
      updateAlignButton();
      var jobDir, render;
      try {
        jobDir = window.UnphasedJobRunner.makeJobDir();
        render = window.UnphasedJobRunner.resolveRenderDir(state.projectPath);
      } catch (e) {
        finish(String(e.message || e), 'error');
        return;
      }
      state.renderDir = render.dir;
      log('Rendering to ' + render.dir);
      if (render.source === 'temp') {
        log('This project has not been saved, so the aligned audio is going to a temp folder that ' +
          'Windows may clear — save the project (or set a rendered audio folder in Settings) and ' +
          'align again to keep it.', 'warn');
      }
      // Rendered files are permanent project media in a folder that persists
      // across runs, so their names must be unique per run: reusing a name
      // would overwrite audio the timeline is already pointing at, and would
      // make the import find the previous run's item in the bin.
      var runStamp = stamp();
      function outputName(pair) {
        return pair.outputFileName.replace(/\.wav$/i, '') + '-' + runStamp + '.wav';
      }

      var distinctTargets = [];
      for (var i = 0; i < pr.pairs.length; i++) {
        if (distinctTargets.indexOf(pr.pairs[i].tgtTrackIndex) === -1) {
          distinctTargets.push(pr.pairs[i].tgtTrackIndex);
        }
      }
      distinctTargets.sort(function (a, b) { return a - b; });

      // Reuse empty tracks already at the bottom rather than appending a fresh
      // set on every run, which would pile up abandoned tracks.
      var allTracks = state.seqInfo.audioTracks;
      var trailingEmpty = 0;
      for (var k = allTracks.length - 1; k >= 0; k--) {
        if (allTracks[k].clipCount === 0) trailingEmpty++;
        else break;
      }
      var reuse = Math.min(trailingEmpty, distinctTargets.length);
      var baseTrackCount = allTracks.length - reuse;

      log('Aligning ' + pr.pairs.length + ' segment(s) from ' + distinctTargets.length + ' track(s)');
      setBusy('Preparing tracks…');
      window.UnphasedBridge.call('AA_ensureTracks', { total: baseTrackCount + distinctTargets.length }, function (tr) {
        if (!tr.ok) {
          finish(tr.error, 'error');
          return;
        }
        if (tr.added) log('Added ' + tr.added + ' audio track(s)');

        var params = readParams();
        var job = {
          ffmpegPath: localStorage.getItem('unphased.ffmpegPath') || undefined,
          tempDir: jobDir,
          params: params,
          pairs: pr.pairs.map(function (p) {
            return { id: p.id, ref: p.ref, target: p.target, outputPath: render.dir + '\\' + outputName(p) };
          })
        };

        var labelById = {};
        var pairById = {};
        pr.pairs.forEach(function (p) { labelById[p.id] = p.label; pairById[p.id] = p; });

        var doneCount = 0;
        var total = pr.pairs.length;
        setProgress(0, true);
        setBusy('Aligning…', true);

        window.UnphasedJobRunner.runJob(job, function (evt) {
          if (evt.event === 'phase') {
            setBusy((labelById[evt.id] || evt.id) + ' — ' + evt.phase + '…', true);
          } else if (evt.event === 'result') {
            doneCount++;
            setProgress((doneCount / total) * 100, true);
            if (evt.status === 'failed') {
              log((labelById[evt.id] || evt.id) + ': ' + (evt.reason || 'failed'), 'error');
            } else {
              // Report a widened search: with the control gone, this is the
              // only visible sign that the sources started far apart.
              var widened = evt.searchWindowMs > 250
                ? ', search widened to ±' + (evt.searchWindowMs >= 1000
                  ? (evt.searchWindowMs / 1000) + ' s' : evt.searchWindowMs + ' ms')
                : '';
              log((labelById[evt.id] || evt.id) + ': ' + fmtMs(evt.staticDelayMs) + ' ms, null ' +
                evt.nullDepthDb.toFixed(0) + ' dB' +
                (evt.polarityInverted ? ', polarity inverted' : '') + widened);
            }
          }
        }).then(function (out) {
          var rows = out.results.map(function (r) {
            r.label = labelById[r.id] || r.id;
            return r;
          });
          if (out.cancelled) {
            renderResults(rows);
            finish('Cancelled — ' + rows.length + ' segment(s) finished before stopping; nothing was placed', 'warn');
            return;
          }
          var okResults = rows.filter(function (r) { return r.status !== 'failed'; });
          if (!okResults.length) {
            renderResults(rows);
            finish('No segments aligned — see results', 'error');
            return;
          }
          setBusy('Placing ' + okResults.length + ' clip(s)…');
          var items = okResults.map(function (r) {
            var p = pairById[r.id];
            return {
              id: r.id,
              path: r.outputPath,
              fileName: outputName(p),
              trackIndex: baseTrackCount + distinctTargets.indexOf(p.tgtTrackIndex),
              startSeconds: p.placeStartSeconds,
              // only silence the original when aligned audio replaces all of it
              muteNodeId: p.muteOriginal ? p.tgtNodeId : null
            };
          });
          window.UnphasedBridge.call('AA_importAndPlace', { items: items }, function (res) {
            if (!res.ok) {
              renderResults(rows);
              finish('Import/placement failed: ' + res.error, 'error');
              return;
            }
            var placeById = {};
            (res.results || []).forEach(function (r) { placeById[r.id] = r; });
            rows.forEach(function (r) {
              var pl = placeById[r.id];
              if (pl) {
                r.placed = pl.ok;
                r.placeError = pl.error;
              }
            });
            renderResults(rows);
            var failedCount = rows.length - okResults.length;
            var placeFailed = okResults.filter(function (r) { return r.placed !== true; }).length;
            var placed = okResults.length - placeFailed;
            var msg = placed + ' clip(s) aligned and placed';
            if (failedCount) msg += ', ' + failedCount + ' failed';
            if (placeFailed) msg += ', ' + placeFailed + ' could not be placed';
            finish(msg, failedCount + placeFailed > 0 ? 'warn' : 'success');
            if (placed) log('Originals muted where fully replaced — unmute to A/B', 'info');
          });
        }).catch(function (err) {
          finish(String(err.message || err), 'error');
        });
      });
    });
  }

  // ─── Live polling ────────────────────────────────────────────────────────
  /**
   * Detects an active sequence appearing or changing, and re-reads
   * automatically. Premiere pushes no event for either: the panel can load
   * before Premiere has settled which sequence is "active", and nothing
   * fires when the user switches sequences while the panel stays open. Both
   * are covered by polling a cheap name-only read and re-reading the full
   * sequence only when the name has actually changed from what is already
   * loaded.
   */
  function pollActiveSequence() {
    if (state.running || state.polling) return;
    state.polling = true;
    window.UnphasedBridge.call('AA_getActiveSequenceName', undefined, function (res) {
      state.polling = false;
      var liveName = (res && res.ok) ? res.name : null;
      if (liveName === state.lastLiveSeqName) return; // nothing changed since the last tick
      state.lastLiveSeqName = liveName;

      var alreadyLoaded = state.seqInfo && state.seqInfo.sequence.name === liveName;
      if (liveName && !alreadyLoaded) {
        refresh();
      } else if (!liveName && state.seqInfo) {
        state.seqInfo = null;
        setSeqInfo('<span class="seq-meta">No active sequence</span>');
        renderTracks();
        updateAlignButton();
      }
    });
  }

  /**
   * Keeps state.liveSelection current, so the track list and the align note
   * always reflect what is selected in the timeline right now — no Refresh
   * needed. AA_getSelectionOnly is a per-clip read with no media probing, so
   * it is cheap enough for the same 2s tick as pollActiveSequence. Skipped
   * entirely when nothing has been read yet, since nothing on screen depends
   * on it before then.
   */
  function pollSelection() {
    if (state.running || state.pollingSelection || !state.seqInfo) return;
    state.pollingSelection = true;
    window.UnphasedBridge.call('AA_getSelectionOnly', undefined, function (res) {
      state.pollingSelection = false;
      if (!res || !res.ok) return; // transient — keep the last-known tally rather than blanking it
      var map = {};
      for (var i = 0; i < res.audioTracks.length; i++) {
        map[res.audioTracks[i].index] = res.audioTracks[i].selectedClipCount;
      }
      state.liveSelection = map;
      state.liveSelectionReported = res.reportedByHost;
      renderTracks();
      updateAlignButton();
    });
  }

  // ─── Instructions ──────────────────────────────────────────────────────────
  function showInstructions(show) {
    var panel = $('instructions-panel');
    if (show) {
      panel.hidden = false;
      // let the browser apply `hidden: false` before transitioning
      requestAnimationFrame(function () { panel.classList.add('visible'); });
    } else {
      panel.classList.remove('visible');
      setTimeout(function () { panel.hidden = true; }, 240);
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  function boot() {
    bindSetting('set-node', 'unphased.nodePath');
    bindSetting('set-engine', 'unphased.enginePath');
    bindSetting('set-ffmpeg', 'unphased.ffmpegPath');
    bindSetting('set-render', 'unphased.renderDir');

    // Any throw inside a handler must reach the log — a silent console-only
    // failure looks identical to "the button does nothing".
    function guard(fn) {
      return function () {
        try {
          fn();
        } catch (e) {
          state.running = false;
          updateAlignButton();
          setBusy(null);
          log((e && e.message ? e.message : String(e)), 'error');
        }
      };
    }

    $('btn-refresh').addEventListener('click', guard(function () { refresh(); }));
    $('btn-sources').addEventListener('click', guard(function () {
      state.showSources = !state.showSources;
      updateSourcesToggle();
    }));
    $('btn-align').addEventListener('click', guard(runAlign));
    $('btn-cancel').addEventListener('click', guard(function () {
      if (window.UnphasedJobRunner.cancel()) {
        $('btn-cancel').disabled = true;
        setBusy('Stopping…');
        log('Cancelling — waiting for the current segment to stop', 'warn');
      }
    }));
    $('btn-clear-log').addEventListener('click', function () { $('log').innerHTML = ''; });
    $('btn-clear-results').addEventListener('click', function () {
      renderResults([]);
      renderWarnings([]);
    });
    $('btn-instructions').addEventListener('click', function () { showInstructions(true); });
    $('btn-instructions-close').addEventListener('click', function () { showInstructions(false); });

    var footerTips = $('footer-tips');
    if (footerTips) {
      footerTips.addEventListener('click', function (e) {
        e.preventDefault();
        cep.util.openURLInDefaultBrowser(footerTips.href);
      });
    }
    $('btn-ping').addEventListener('click', guard(function () {
      window.UnphasedBridge.call('AA_ping', undefined, function (res) {
        var st = renderToolStatus();
        var out = $('dev-out');
        var render;
        try {
          render = window.UnphasedJobRunner.resolveRenderDir(state.projectPath);
        } catch (e) { render = { dir: String(e.message || e), source: 'error' }; }
        out.hidden = false;
        out.textContent = JSON.stringify(res, null, 2) +
          '\nnode:   ' + (st.node || 'NOT FOUND') +
          '\nengine: ' + (st.engine || 'NOT FOUND') +
          '\nffmpeg: ' + (st.ffmpeg || 'NOT FOUND') +
          '\nrender: ' + render.dir + ' (' + render.source + ')';
      });
    }));

    window.addEventListener('error', function (ev) { log('Panel error: ' + ev.message, 'error'); });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev.reason;
      log('Panel error: ' + (r && r.message ? r.message : String(r)), 'error');
    });

    var missing = [];
    if (!window.UnphasedPairing) missing.push('pairing.js');
    if (!window.UnphasedJobRunner) missing.push('jobRunner.js');
    if (!window.UnphasedBridge) missing.push('bridge.js');
    if (missing.length) {
      $('boot-error').hidden = false;
      $('boot-error').textContent = 'Failed to load: ' + missing.join(', ') + ' — reload the panel.';
      return;
    }

    if (!window.__adobe_cep__) {
      $('boot-error').hidden = false;
      $('boot-error').textContent = 'Not running inside Premiere Pro (CEP bridge missing). UI preview only.';
      return;
    }

    renderToolStatus();
    window.UnphasedBridge.loadJsx(function (err) {
      if (err) {
        $('boot-error').hidden = false;
        $('boot-error').textContent = err;
        log(err, 'error');
        return;
      }
      log('Panel ready');
      // `quiet` suppresses the "No active sequence" error log for this one
      // boot-time attempt — a known, benign startup race (see
      // pollActiveSequence) that self-resolves within a couple of seconds. A
      // manual Refresh click, or any later automatic re-refresh, always logs.
      refresh(function () {
        // Start the poll once the initial read has settled, successfully or
        // not — it is what catches the case this boot-time attempt just
        // missed, and keeps catching it for as long as the panel stays open.
        // pollSelection() rides the same tick, keeping the track list and
        // align note live.
        setInterval(function () {
          guard(pollActiveSequence)();
          guard(pollSelection)();
        }, 2000);
      }, { quiet: true });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
