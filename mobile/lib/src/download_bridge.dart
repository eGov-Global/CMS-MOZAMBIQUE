import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// Bridges in-page file downloads to the native side (#173).
///
/// The portal builds its PDFs (complaint receipt, exports) in the page with
/// jsPDF / pdfmake and "downloads" them the FileSaver way: a detached
/// `<a download href="blob:…">` that receives a synthetic click. A browser
/// saves the file; a WebView has nobody listening, so the tap does nothing.
/// `webview_flutter` exposes no download listener, and even a native one
/// could not read a `blob:` URL, which only exists inside the page.
///
/// So the page is given [downloadBridgeScript]. It remembers every blob the
/// page turns into an object URL, catches the click (real, `.click()` or
/// dispatched) on any `blob:` / `data:` anchor as well as `window.open` on
/// such URLs, and posts the bytes as base64 on the [downloadBridgeChannel]
/// JavaScript channel. The native side parses that into a [DownloadRequest],
/// writes the file and hands it to the system share sheet, where the citizen
/// can save it or open it in a PDF viewer.
///
/// Name of the JavaScript channel the page posts downloads on.
const String downloadBridgeChannel = 'FalaCidadaoDownload';

/// Largest download accepted from the page, in bytes. A receipt is a few
/// hundred KB; the cap only keeps a runaway page from exhausting memory.
const int downloadBridgeMaxBytes = 25 * 1024 * 1024;

/// Injected after every page load. Idempotent: a second injection on the same
/// document is a no-op, so SPA navigations and reloads are both safe.
const String downloadBridgeScript = r'''
(function () {
  if (window.__fcDownloadBridge) return;
  var channel = window.FalaCidadaoDownload;
  if (!channel || typeof channel.postMessage !== 'function') return;
  window.__fcDownloadBridge = true;

  // blob: URL -> Blob, so a click can be served without a fetch that may
  // race FileSaver's 40 s revoke.
  var blobs = {};
  var createObjectURL = URL.createObjectURL.bind(URL);
  var revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var url = createObjectURL(obj);
    if (obj instanceof Blob) blobs[url] = obj;
    return url;
  };
  URL.revokeObjectURL = function (url) {
    delete blobs[url];
    return revokeObjectURL(url);
  };

  function post(name, mime, base64) {
    channel.postMessage(JSON.stringify({ name: name || '', mime: mime || '', data: base64 }));
  }

  function postBlob(blob, name) {
    var reader = new FileReader();
    reader.onload = function () {
      var result = String(reader.result || '');
      var comma = result.indexOf(',');
      post(name, blob.type, comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  }

  // Returns true when the URL was taken over by the bridge.
  function capture(url, name) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('blob:') === 0) {
      var blob = blobs[url];
      if (blob) {
        postBlob(blob, name);
      } else {
        fetch(url).then(function (r) { return r.blob(); }).then(function (b) { postBlob(b, name); });
      }
      return true;
    }
    if (url.indexOf('data:') === 0) {
      var comma = url.indexOf(',');
      if (comma < 0) return false;
      var header = url.slice(5, comma);
      var payload = url.slice(comma + 1);
      var mime = header.split(';')[0];
      if (/;base64$/i.test(header)) {
        post(name, mime, payload);
      } else {
        post(name, mime, btoa(unescape(decodeURIComponent(payload))));
      }
      return true;
    }
    return false;
  }

  function anchorName(a) {
    var n = a.getAttribute('download');
    return n && n !== 'true' ? n : '';
  }

  function isDownloadAnchor(a) {
    return a instanceof HTMLAnchorElement && (a.hasAttribute('download') || /^(blob|data):/.test(a.href));
  }

  // FileSaver (jsPDF, pdfmake) clicks a DETACHED anchor via dispatchEvent, so
  // a document listener never sees it: hook the element methods themselves.
  var dispatchEvent = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (event) {
    if (event && event.type === 'click' && isDownloadAnchor(this) && capture(this.href, anchorName(this))) {
      return false;
    }
    return dispatchEvent.call(this, event);
  };
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isDownloadAnchor(this) && capture(this.href, anchorName(this))) return;
    return click.call(this);
  };

  // A real tap on an anchor that is in the document.
  document.addEventListener('click', function (event) {
    var a = event.target && event.target.closest ? event.target.closest('a') : null;
    if (a && isDownloadAnchor(a) && capture(a.href, anchorName(a))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  var open = window.open;
  window.open = function (url) {
    if (capture(url, '')) return null;
    return open.apply(window, arguments);
  };
})();
''';

/// One file the page asked to download, decoded and ready to write.
class DownloadRequest {
  final String name;
  final String mimeType;
  final Uint8List bytes;

  const DownloadRequest({
    required this.name,
    required this.mimeType,
    required this.bytes,
  });

  /// Parses a channel message. Returns null for anything the bridge did not
  /// produce: bad JSON, no payload, undecodable base64, or more than
  /// [downloadBridgeMaxBytes] once decoded.
  static DownloadRequest? parse(String message) {
    Object? decoded;
    try {
      decoded = jsonDecode(message);
    } on FormatException {
      return null;
    }
    if (decoded is! Map<String, dynamic>) return null;
    final data = decoded['data'];
    if (data is! String || data.isEmpty) return null;
    // Decoded size is 3/4 of the text; refuse before allocating anything big.
    if (data.length > downloadBridgeMaxBytes * 4 ~/ 3 + 4) return null;
    Uint8List bytes;
    try {
      bytes = base64Decode(base64.normalize(data));
    } on FormatException {
      return null;
    }
    if (bytes.isEmpty || bytes.length > downloadBridgeMaxBytes) return null;
    final mime = (decoded['mime'] is String ? decoded['mime'] as String : '').trim();
    return DownloadRequest(
      name: safeFileName(decoded['name'] is String ? decoded['name'] as String : '', mime),
      mimeType: mime.isEmpty ? 'application/octet-stream' : mime,
      bytes: bytes,
    );
  }

  /// Writes the bytes under [directory]/downloads, never overwriting an
  /// earlier file of the same name, and returns the file.
  Future<File> writeTo(Directory directory) async {
    final folder = Directory('${directory.path}${Platform.pathSeparator}downloads');
    await folder.create(recursive: true);
    var file = File('${folder.path}${Platform.pathSeparator}$name');
    if (await file.exists()) {
      final dot = name.lastIndexOf('.');
      final stem = dot > 0 ? name.substring(0, dot) : name;
      final ext = dot > 0 ? name.substring(dot) : '';
      file = File(
        '${folder.path}${Platform.pathSeparator}$stem-${DateTime.now().millisecondsSinceEpoch}$ext',
      );
    }
    return file.writeAsBytes(bytes, flush: true);
  }
}

const Map<String, String> _extensionForMime = {
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

/// Reduces whatever the page offered as a file name to a single safe path
/// segment: no directories, no control characters, a sensible length, and an
/// extension matching the MIME type when the page gave none.
String safeFileName(String raw, String mimeType) {
  var name = raw.trim();
  // Keep only the last path segment, whichever separator the page used.
  name = name.split(RegExp(r'[\\/]')).last;
  name = name.replaceAll(RegExp(r'[\x00-\x1f<>:"|?*]'), '_').trim();
  while (name.startsWith('.')) {
    name = name.substring(1);
  }
  if (name.length > 120) name = name.substring(name.length - 120);
  if (name.isEmpty) name = 'download';
  final ext = _extensionForMime[mimeType.toLowerCase()];
  if (ext != null && !name.toLowerCase().endsWith(ext)) {
    name = '$name$ext';
  }
  return name;
}
