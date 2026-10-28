/* Reads a .zip (a .docx or .pptx is one) in the browser, with no library: the central directory says where
   each file is, and the browser's own DecompressionStream inflates it. Zip64 and encryption aren't handled. */
(function () {
  function u16(v, o) { return v.getUint16(o, true); }
  function u32(v, o) { return v.getUint32(o, true); }

  function inflate(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function open(buf) {
    var v = new DataView(buf), all = new Uint8Array(buf), end = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (u32(v, i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('This isn’t a zip file');
    var count = u16(v, end + 10), at = u32(v, end + 16), entries = {}, dec = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (u32(v, at) !== 0x02014b50) throw new Error('The zip’s directory is damaged');
      var nameLen = u16(v, at + 28), name = dec.decode(all.subarray(at + 46, at + 46 + nameLen));
      entries[name] = { method: u16(v, at + 10), size: u32(v, at + 20), local: u32(v, at + 42) };
      at += 46 + nameLen + u16(v, at + 30) + u16(v, at + 32);
    }
    function bytes(name) {
      var e = entries[name]; if (!e) return Promise.resolve(null);
      var start = e.local + 30 + u16(v, e.local + 26) + u16(v, e.local + 28), data = all.subarray(start, start + e.size);
      if (e.method === 0) return Promise.resolve(data);
      if (e.method === 8) return inflate(data);
      return Promise.reject(new Error('Unsupported compression in ' + name));
    }
    return {
      names: Object.keys(entries),
      has: function (name) { return !!entries[name]; },
      bytes: bytes,
      text: function (name) { return bytes(name).then(function (b) { return b && dec.decode(b); }); },
      xml: function (name) { return bytes(name).then(function (b) { return b && new DOMParser().parseFromString(dec.decode(b), 'application/xml'); }); }
    };
  }

  window.Zip = { open: open, supported: typeof DecompressionStream === 'function' };
})();
