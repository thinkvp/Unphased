// Premiere audio Level conversion, used by the panel and unit-tested from the
// engine's test runner, which imports this file directly.
//
// Premiere stores a clip's Volume > Level as a float in [0, 1], not as decibels:
// the scale is logarithmic with 1.0 at +15 dB, so
//
//     level = 10 ^ ((dB - 15) / 20)          dB = 20 * log10(level) + 15
//
// THE +15 OFFSET IS THE ONE NUMBER WE CANNOT VERIFY WITHOUT PREMIERE. It comes
// from the scripting community rather than from Adobe's documentation, and it
// only affects the ABSOLUTE conversions below.
//
// Auto-mix does not need them. A duck is a RELATIVE change, and in the linear
// domain a relative change is a plain multiply:
//
//     level(a + b) = 10^((a + b - 15)/20) = level(a) * 10^(b/20)
//
// The offset cancels. So `duckLevel` — the only function the keyframe writer
// actually calls — is correct whatever Premiere's unity reference turns out to
// be, and a wrong offset can at worst mislabel a number in a log line. Keep it
// that way: do not "simplify" duckLevel into dbToLevel(levelToDb(x) + duckDb).

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UnphasedVolume = api;
}(typeof self !== 'undefined' ? self : this, function () {

  // Level at which Premiere shows 0 dB, i.e. unity gain.
  var UNITY_LEVEL = Math.pow(10, -15 / 20);

  /** dB (relative to unity) -> Premiere Level parameter value in [0, 1]. */
  function dbToLevel(db) {
    return clamp01(Math.pow(10, (db - 15) / 20));
  }

  /** Premiere Level parameter value -> dB. Returns -Infinity at silence. */
  function levelToDb(level) {
    if (!(level > 0)) return -Infinity;
    return 20 * Math.log(level) * Math.LOG10E + 15;
  }

  /**
   * Apply a relative gain change to an existing Level value.
   *
   * This is what the keyframe writer uses: the clip's own level is whatever the
   * editor already set, and auto-mix ducks relative to it rather than replacing
   * it. Offset-independent — see the header.
   *
   * @param {number} currentLevel existing Level in [0, 1]
   * @param {number} deltaDb gain change in dB; auto-mix only ever passes <= 0
   */
  function duckLevel(currentLevel, deltaDb) {
    var base = typeof currentLevel === 'number' && isFinite(currentLevel) && currentLevel >= 0
      ? currentLevel
      : UNITY_LEVEL;
    return clamp01(base * Math.pow(10, deltaDb / 20));
  }

  /**
   * Turn the engine's clip-relative keyframe list into Level values against the
   * clip's existing level.
   *
   * Times are passed through untouched. Offsetting them by the clip's source
   * in-point is the host layer's job and MUST NOT be forgotten — Premiere
   * positions keyframes in source time, and a clip with no underlying footage
   * (titles, graphics, adjustment layers) starts at one hour, so keyframes
   * written at timeline-relative times silently land nowhere.
   *
   * @param {Array<{timeSec:number, gainDb:number}>} keys from the engine
   * @param {number} currentLevel the clip's existing Level
   */
  function levelKeyframes(keys, currentLevel) {
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      out.push({
        timeSec: keys[i].timeSec,
        level: duckLevel(currentLevel, keys[i].gainDb),
        gainDb: keys[i].gainDb
      });
    }
    return out;
  }

  function clamp01(v) {
    if (!(v > 0)) return 0;
    return v > 1 ? 1 : v;
  }

  return {
    UNITY_LEVEL: UNITY_LEVEL,
    dbToLevel: dbToLevel,
    levelToDb: levelToDb,
    duckLevel: duckLevel,
    levelKeyframes: levelKeyframes
  };
}));
