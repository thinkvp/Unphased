// Compact JSON polyfill for ExtendScript (ES3). Parse uses the classic
// json2.org safety-check-then-eval approach; stringify is a plain recursive
// serializer covering the types this panel exchanges.

if (typeof JSON === 'undefined') {
  JSON = {};
}

(function () {
  function quote(s) {
    var meta = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (meta[c]) out += meta[c];
      else if (c < ' ') {
        var code = c.charCodeAt(0).toString(16);
        out += '\\u' + ('0000' + code).slice(-4);
      } else out += c;
    }
    return out + '"';
  }

  function str(value) {
    var t = typeof value;
    if (value === null || t === 'undefined') return 'null';
    if (t === 'number') return isFinite(value) ? String(value) : 'null';
    if (t === 'boolean') return String(value);
    if (t === 'string') return quote(value);
    if (t === 'object') {
      var i, out;
      if (value instanceof Array) {
        out = [];
        for (i = 0; i < value.length; i++) out.push(str(value[i]));
        return '[' + out.join(',') + ']';
      }
      out = [];
      for (var k in value) {
        if (value.hasOwnProperty(k) && typeof value[k] !== 'function') {
          out.push(quote(k) + ':' + str(value[k]));
        }
      }
      return '{' + out.join(',') + '}';
    }
    return 'null';
  }

  if (typeof JSON.stringify !== 'function') {
    JSON.stringify = function (value) { return str(value); };
  }

  if (typeof JSON.parse !== 'function') {
    JSON.parse = function (text) {
      text = String(text);
      if (/^[\],:{}\s]*$/.test(
        text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
          .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
          .replace(/(?:^|:|,)(?:\s*\[)+/g, ''))) {
        return eval('(' + text + ')');
      }
      throw new Error('JSON.parse: unsafe input');
    };
  }
})();
