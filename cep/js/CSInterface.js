// Minimal CSInterface: just what this panel uses (evalScript + system paths).
// Talks directly to the __adobe_cep__ bridge injected by CEP's CEF runtime.

function CSInterface() {}

var SystemPath = {
  EXTENSION: 'extension',
  USER_DATA: 'userData',
  HOST_APPLICATION: 'hostApplication'
};

CSInterface.prototype.evalScript = function (script, callback) {
  callback = callback || function () {};
  if (!window.__adobe_cep__) {
    callback('EvalScript error: not running inside CEP');
    return;
  }
  window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getSystemPath = function (pathType) {
  var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
  var start = path.indexOf('file:///');
  if (start === 0) path = path.substring(8);
  else if (path.indexOf('file://') === 0) path = path.substring(7);
  return path;
};
