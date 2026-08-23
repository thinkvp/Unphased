// Pure pairing logic: match each clip on the target tracks with overlapping
// reference-track material and derive source-media extraction intervals.
// No host or DOM dependencies — unit-tested from the engine's test runner,
// which requires this file directly (see engine/test/pairing.test.js).

// UMD rather than a bare `module.exports`: the panel loads this file with a
// <script> tag, while the engine test suite requires it as a CommonJS module.
// Assign to both, unconditionally — an `if (module) ... else global` wrapper
// would leave one of the two consumers with nothing.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UnphasedPairing = api;
}(typeof self !== 'undefined' ? self : this, function () {

  function usable(clip, warnings, why) {
    if (!clip.mediaPath) {
      warnings.push({ clip: clip.name, reason: 'offline or unresolvable media path — skipped' });
      return false;
    }
    if (Math.abs((clip.speedFactor || 1) - 1) > 1e-6) {
      warnings.push({ clip: clip.name, reason: 'speed/time-remap is not 100% — skipped' });
      return false;
    }
    if (clip.startSeconds === null || clip.inPointSeconds === null) {
      warnings.push({ clip: clip.name, reason: 'missing timing info — skipped' });
      return false;
    }
    return true;
  }

  function sanitize(name) {
    return String(name || 'clip').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  }

  /** First resolvable media path on a track, or null. */
  function trackPath(track) {
    for (var c = 0; c < track.clips.length; c++) {
      if (track.clips[c].mediaPath) return track.clips[c].mediaPath;
    }
    return null;
  }

  /**
   * How many audio tracks draw on each media file.
   * @returns {object} map of mediaPath -> track count
   */
  function tracksPerPath(seqInfo) {
    var counts = {};
    for (var i = 0; i < seqInfo.audioTracks.length; i++) {
      var path = trackPath(seqInfo.audioTracks[i]);
      if (path) counts[path] = (counts[path] || 0) + 1;
    }
    return counts;
  }

  /**
   * Default source-stream assignment for tracks that share one media file.
   * Multi-input cameras (FX6 etc.) write one mono stream per mic and Premiere
   * lays them onto consecutive tracks in stream order, so track order within a
   * file is the right default. Without this, every track of such a file would
   * extract stream 0 and "align" identical audio against itself.
   *
   * A multi-channel file used by only ONE track is the opposite case — an
   * ordinary stereo recording, not two mics — so it keeps every channel.
   * Pinning it to channel 0 would also render the clip mono, since the render
   * path only preserves channels when no single channel was chosen.
   * @returns {object} map of trackIndex -> {audioStream, channel}
   */
  function defaultSourceMap(seqInfo, probeByPath) {
    var map = {};
    var seenPerFile = {};
    var shared = tracksPerPath(seqInfo);
    for (var i = 0; i < seqInfo.audioTracks.length; i++) {
      var track = seqInfo.audioTracks[i];
      var path = trackPath(track);
      if (!path) continue;
      var ordinal = seenPerFile[path] || 0;
      seenPerFile[path] = ordinal + 1;
      var probe = probeByPath && probeByPath[path];
      var streams = (probe && probe.streams) || [];
      if (streams.length > 1) {
        // one mono stream per input: nth track using this file -> nth stream
        map[i] = { audioStream: Math.min(ordinal, streams.length - 1), channel: null };
      } else if (streams.length === 1 && streams[0].channels > 1 && shared[path] > 1) {
        // several tracks on one interleaved stream: nth track -> nth channel
        map[i] = { audioStream: 0, channel: Math.min(ordinal, streams[0].channels - 1) };
      } else {
        map[i] = { audioStream: 0, channel: null };
      }
    }
    return map;
  }

  /**
   * @param {object} seqInfo AA_getSequenceInfo payload
   * @param {number} refTrackIndex
   * @param {number[]} targetTrackIndexes
   * @param {object} opts { minOverlapSec, sourceMap, selectedOnly }
   *   selectedOnly scopes the TARGETS to clips selected in the timeline. The
   *   reference track is never filtered: it is the yardstick, and a reference
   *   clip is needed wherever a target overlaps it whether or not the editor
   *   happened to select it. This is what lets one track hold different roles
   *   across a sequence, which track-wide targeting cannot express.
   * @returns {{ pairs: [], warnings: [] }}
   *   pair: { id, label, ref: {mediaPath,startSec,durationSec}, target: {...},
   *           placeStartSeconds, alignStartSeconds, alignDurationSec,
   *           tgtNodeId, tgtTrackIndex, outputFileName, partial }
   */
  function buildPairs(seqInfo, refTrackIndex, targetTrackIndexes, opts) {
    opts = opts || {};
    var minOverlapSec = opts.minOverlapSec === undefined ? 2 : opts.minOverlapSec;
    var sourceMap = opts.sourceMap || {};
    var selectedOnly = !!opts.selectedOnly;
    var skippedUnselected = 0;
    function srcOf(trackIndex) {
      return sourceMap[trackIndex] || { audioStream: 0, channel: null };
    }
    var warnings = [];
    var pairs = [];
    var refTrack = seqInfo.audioTracks[refTrackIndex];
    if (!refTrack) return { pairs: [], warnings: [{ clip: null, reason: 'reference track missing' }] };
    var refClips = [];
    for (var i = 0; i < refTrack.clips.length; i++) {
      var rc = refTrack.clips[i];
      if (usable(rc, warnings)) refClips.push(rc);
    }
    if (!refClips.length) {
      return { pairs: [], warnings: warnings.concat([{ clip: null, reason: 'no usable clips on reference track' }]) };
    }

    var counter = 0;
    for (var t = 0; t < targetTrackIndexes.length; t++) {
      var trackIdx = targetTrackIndexes[t];
      if (trackIdx === refTrackIndex) continue;
      var track = seqInfo.audioTracks[trackIdx];
      if (!track) continue;
      for (var c = 0; c < track.clips.length; c++) {
        var clip = track.clips[c];
        // Scope check before usability: an unselected clip is out of scope, not
        // a problem, and must not produce a warning about being offline or
        // speed-changed.
        if (selectedOnly && !clip.selected) { skippedUnselected++; continue; }
        if (!usable(clip, warnings)) continue;

        // Every overlapping reference clip yields its own segment. Reference
        // clips on one track cannot overlap each other, so segments are
        // disjoint and can be aligned independently — a target spanning an
        // edit in the reference gets aligned across its whole length instead
        // of only against the single longest overlap.
        var segments = [];
        var tooShort = 0;
        for (var r = 0; r < refClips.length; r++) {
          var rc2 = refClips[r];
          var s = Math.max(clip.startSeconds, rc2.startSeconds);
          var e = Math.min(clip.endSeconds, rc2.endSeconds);
          if (e - s <= 0) continue;
          if (e - s < minOverlapSec) { tooShort++; continue; }
          segments.push({ refClip: rc2, start: s, end: e, len: e - s });
        }
        if (!segments.length) {
          warnings.push({
            clip: clip.name,
            reason: 'insufficient overlap with reference track (< ' + minOverlapSec + ' s) — skipped'
          });
          continue;
        }
        segments.sort(function (x, y) { return x.start - y.start; });
        if (tooShort) {
          warnings.push({
            clip: clip.name,
            reason: tooShort + ' reference segment(s) shorter than ' + minOverlapSec +
              ' s were skipped; those parts keep the original audio'
          });
        }

        var clipLen = clip.endSeconds - clip.startSeconds;
        var covered = 0;
        for (var g = 0; g < segments.length; g++) covered += segments[g].len;
        // Only silence the original when the aligned segments actually replace
        // it end to end; muting a partially-covered clip would leave a hole.
        var coversWholeClip = covered >= clipLen - 0.02;
        if (!coversWholeClip) {
          warnings.push({
            clip: clip.name,
            reason: 'reference covers ' + Math.round((covered / clipLen) * 100) +
              '% of this clip; the original is left audible so no gap is created'
          });
        }

        var refSrc = srcOf(refTrackIndex);
        var tgtSrc = srcOf(trackIdx);
        var emitted = 0;

        for (var g2 = 0; g2 < segments.length; g2++) {
          var seg = segments[g2];
          var refClip = seg.refClip;
          var refStartSec = refClip.inPointSeconds + (seg.start - refClip.startSeconds);
          var tgtStartSec = clip.inPointSeconds + (seg.start - clip.startSeconds);

          // Refuse to "align" a signal against itself: same file, same source
          // time, same stream/channel means both sides decode identical audio,
          // which yields a flawless-looking but entirely meaningless result.
          if (refClip.mediaPath === clip.mediaPath &&
              Math.abs(refStartSec - tgtStartSec) < 0.001 &&
              refSrc.audioStream === tgtSrc.audioStream &&
              refSrc.channel === tgtSrc.channel) {
            warnings.push({
              clip: clip.name,
              reason: 'reference and target resolve to the same audio (same file, same time, ' +
                'same channel) — nothing to align; pick a different reference track'
            });
            continue;
          }

          var id = 'p' + (counter++);
          pairs.push({
            id: id,
            label: clip.name + (segments.length > 1 ? ' [' + (g2 + 1) + '/' + segments.length + ']' : ''),
            ref: {
              mediaPath: refClip.mediaPath,
              startSec: refStartSec,
              durationSec: seg.len,
              audioStream: refSrc.audioStream,
              channel: refSrc.channel
            },
            target: {
              mediaPath: clip.mediaPath,
              startSec: tgtStartSec,
              durationSec: seg.len,
              audioStream: tgtSrc.audioStream,
              channel: tgtSrc.channel
            },
            placeStartSeconds: seg.start,
            alignStartSeconds: seg.start,
            alignDurationSec: seg.len,
            tgtNodeId: clip.nodeId,
            tgtTrackIndex: trackIdx,
            outputFileName: sanitize(clip.name) + '-aligned-' + id + '.wav',
            // mute the original once, and only if it is fully replaced
            muteOriginal: coversWholeClip && emitted === 0,
            segmentIndex: g2,
            segmentCount: segments.length,
            coversWholeClip: coversWholeClip,
            partial: !coversWholeClip
          });
          emitted++;
        }
      }
    }
    if (selectedOnly && !pairs.length && skippedUnselected) {
      warnings.push({
        clip: null,
        reason: 'no clips are selected on the target track(s) — select some in the timeline first'
      });
    }
    return { pairs: pairs, warnings: warnings, skippedUnselected: skippedUnselected };
  }

  return {
    buildPairs: buildPairs,
    sanitize: sanitize,
    defaultSourceMap: defaultSourceMap,
    tracksPerPath: tracksPerPath
  };
}));
