// evalScript wrapper: loads the jsx layer once, then exchanges JSON with the
// AA_* host functions. Owns all string escaping between the two worlds.

window.UnphasedBridge = (function () {
  var cs = new CSInterface();
  var extPath = null;
  try { extPath = cs.getSystemPath(SystemPath.EXTENSION); } catch (e) {}

  function jsxDir() {
    return String(extPath).replace(/\\/g, '/') + '/jsx';
  }

  function loadJsx(cb) {
    var dir = jsxDir();
    var script = '$.evalFile("' + dir + '/json2.jsx"); $.evalFile("' + dir + '/host.jsx"); "jsx-loaded"';
    cs.evalScript(script, function (res) {
      cb(res === 'jsx-loaded' ? null : 'Failed to load jsx: ' + res);
    });
  }

  function call(fnName, argObj, cb) {
    var argSrc = '';
    if (argObj !== undefined && argObj !== null) {
      argSrc = "'" + JSON.stringify(argObj).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    }
    cs.evalScript(fnName + '(' + argSrc + ')', function (res) {
      var out;
      try {
        out = JSON.parse(res);
      } catch (e) {
        out = { ok: false, error: 'Bad response from ' + fnName + ': ' + String(res).slice(0, 300) };
      }
      cb(out);
    });
  }

  return { loadJsx: loadJsx, call: call, extensionPath: extPath };
})();
