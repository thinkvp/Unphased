// Spawns the system Node running engine/cli.js and streams its NDJSON
// events. Uses CEP's embedded Node only for fs/child_process plumbing — the
// DSP always runs in the (modern) system Node.

window.UnphasedJobRunner = (function () {
  var activeChild = null;
  var cancelled = false;

  function nodeModules() {
    if (typeof require === 'undefined') {
      throw new Error('Node integration is disabled — check --enable-nodejs in the manifest and PlayerDebugMode.');
    }
    return {
      fs: require('fs'),
      path: require('path'),
      os: require('os'),
      cp: require('child_process')
    };
  }

  function realExtensionDir() {
    var m = nodeModules();
    // cep/ is junctioned into the CEP extensions dir; realpath resolves back
    // to the repo so we can find engine/ next to cep/
    return m.fs.realpathSync(window.UnphasedBridge.extensionPath);
  }

  function engineCliPath() {
    var m = nodeModules();
    var custom = localStorage.getItem('unphased.enginePath');
    if (custom) return custom;
    return m.path.join(m.path.dirname(realExtensionDir()), 'engine', 'cli.js');
  }

  function resolveNode() {
    var m = nodeModules();
    var custom = localStorage.getItem('unphased.nodePath');
    if (custom) return custom;
    try {
      var found = m.cp.execSync('where node', { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)[0].trim();
      if (found && m.fs.existsSync(found)) return found;
    } catch (e) {}
    var candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\nvm4w\\nodejs\\node.exe'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (m.fs.existsSync(candidates[i])) return candidates[i];
    }
    return null;
  }

  /** Scratch space for job.json and the extracted ref/tgt slices — genuinely
   *  throwaway, so the temp folder is the right home for it. */
  function makeJobDir() {
    var m = nodeModules();
    var dir = m.path.join(m.os.tmpdir(), 'Unphased', 'job-' + Date.now());
    m.fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Where the rendered WAVs go. These are *project media*: Premiere keeps
   * referencing them for the life of the project, so the temp folder is the
   * wrong place — Disk Cleanup, Storage Sense and a reboot all take it, and
   * the timeline goes offline weeks later with no clue why. Default to a
   * folder beside the project file so the audio travels with the project.
   *
   * @param {string|null} projectPath the .prproj path, null when unsaved
   * @returns {{ dir: string, source: 'settings'|'project'|'temp' }}
   */
  function resolveRenderDir(projectPath) {
    var m = nodeModules();
    var custom = (localStorage.getItem('unphased.renderDir') || '').trim();
    if (custom) {
      m.fs.mkdirSync(custom, { recursive: true });
      return { dir: custom, source: 'settings' };
    }
    if (projectPath) {
      var dir = m.path.join(m.path.dirname(projectPath), 'Unphased Audio');
      try {
        m.fs.mkdirSync(dir, { recursive: true });
        return { dir: dir, source: 'project' };
      } catch (e) { /* read-only or missing volume — fall through */ }
    }
    var fallback = m.path.join(m.os.tmpdir(), 'Unphased', 'render');
    m.fs.mkdirSync(fallback, { recursive: true });
    return { dir: fallback, source: 'temp' };
  }

  /**
   * @param {object} job engine job (pairs already carry absolute outputPath)
   * @param {function} onEvent called per NDJSON event
   * @returns {Promise<{results: object[], exitCode: number}>}
   */
  function runJob(job, onEvent) {
    var m = nodeModules();
    return new Promise(function (resolve, reject) {
      var nodePath = resolveNode();
      if (!nodePath) {
        reject(new Error('Could not find node.exe — set it in Settings.'));
        return;
      }
      var cli = engineCliPath();
      if (!m.fs.existsSync(cli)) {
        reject(new Error('Engine not found at ' + cli + ' — set it in Settings.'));
        return;
      }
      var jobPath = m.path.join(job.tempDir, 'job.json');
      m.fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));

      var child = m.cp.spawn(nodePath, [cli, 'run', jobPath], { windowsHide: true });
      activeChild = child;
      var buffer = '';
      var results = [];
      var stderrTail = '';
      child.stdout.on('data', function (chunk) {
        buffer += chunk.toString('utf8');
        var lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          var evt;
          try { evt = JSON.parse(lines[i]); } catch (e) { continue; }
          if (evt.event === 'result') results.push(evt);
          try { onEvent && onEvent(evt); } catch (e2) {}
        }
      });
      child.stderr.on('data', function (chunk) {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
      });
      child.on('error', function (err) {
        activeChild = null;
        reject(new Error('Failed to spawn engine: ' + err.message));
      });
      child.on('close', function (code) {
        var wasCancelled = cancelled;
        activeChild = null;
        cancelled = false;
        if (wasCancelled) {
          resolve({ results: results, exitCode: code, cancelled: true });
        } else if (code !== 0 && results.length === 0) {
          reject(new Error('Engine exited with code ' + code + (stderrTail ? ': ' + stderrTail : '')));
        } else {
          resolve({ results: results, exitCode: code });
        }
      });
    });
  }

  /**
   * Ask the engine for each media file's audio stream/channel layout.
   * @returns {Promise<object>} map of mediaPath -> { streams: [{index, channels}] }
   */
  function probeMedia(paths, ffmpegPath) {
    var m = nodeModules();
    return new Promise(function (resolve, reject) {
      if (!paths.length) { resolve({}); return; }
      var nodePath = resolveNode();
      var cli = engineCliPath();
      if (!nodePath || !m.fs.existsSync(cli)) { resolve({}); return; }
      var dir = m.path.join(m.os.tmpdir(), 'Unphased');
      m.fs.mkdirSync(dir, { recursive: true });
      var listPath = m.path.join(dir, 'probe.json');
      m.fs.writeFileSync(listPath, JSON.stringify({ ffmpegPath: ffmpegPath || undefined, paths: paths }));
      m.cp.execFile(nodePath, [cli, 'probe', listPath], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        function (err, stdout) {
          if (err) { reject(new Error('probe failed: ' + err.message)); return; }
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
        });
    });
  }

  /** Stop a running engine. Pairs already finished keep their results. */
  function cancel() {
    if (!activeChild) return false;
    cancelled = true;
    try { activeChild.kill(); } catch (e) { /* already gone */ }
    return true;
  }

  function isRunning() { return !!activeChild; }

  /** Report whether the external tools the panel depends on were found. */
  function toolStatus() {
    var out = { node: null, ffmpeg: null, engine: null };
    try {
      var m = nodeModules();
      out.node = resolveNode();
      var cli = engineCliPath();
      out.engine = m.fs.existsSync(cli) ? cli : null;
      var configured = localStorage.getItem('unphased.ffmpegPath');
      var candidates = [configured, 'C:\\ffmpeg\\bin\\ffmpeg.exe'].filter(Boolean);
      for (var i = 0; i < candidates.length; i++) {
        if (m.fs.existsSync(candidates[i])) { out.ffmpeg = candidates[i]; break; }
      }
      if (!out.ffmpeg) {
        try {
          var found = m.cp.execSync('where ffmpeg', { encoding: 'utf8', windowsHide: true })
            .split(/\r?\n/)[0].trim();
          if (found && m.fs.existsSync(found)) out.ffmpeg = found;
        } catch (e) { /* not on PATH */ }
      }
    } catch (e) { /* node integration unavailable */ }
    return out;
  }

  return {
    runJob: runJob,
    probeMedia: probeMedia,
    resolveNode: resolveNode,
    engineCliPath: engineCliPath,
    makeJobDir: makeJobDir,
    resolveRenderDir: resolveRenderDir,
    cancel: cancel,
    isRunning: isRunning,
    toolStatus: toolStatus
  };
})();
