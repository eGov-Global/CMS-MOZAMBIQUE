import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:cms_mozambique/src/download_bridge.dart';

String message({String? name, String? mime, Object? data}) => jsonEncode({
      'name': ?name,
      'mime': ?mime,
      'data': ?data,
    });

void main() {
  final pdfBytes = utf8.encode('%PDF-1.4 receipt');
  final pdfBase64 = base64Encode(pdfBytes);

  group('DownloadRequest.parse', () {
    test('decodes what the page bridge posts', () {
      final r = DownloadRequest.parse(
          message(name: 'PGR-2026-10-000123.pdf', mime: 'application/pdf', data: pdfBase64));
      expect(r, isNotNull);
      expect(r!.name, 'PGR-2026-10-000123.pdf');
      expect(r.mimeType, 'application/pdf');
      expect(r.bytes, pdfBytes);
    });

    test('accepts the unpadded base64 a FileReader data URL may carry', () {
      final unpadded = pdfBase64.replaceAll('=', '');
      expect(DownloadRequest.parse(message(data: unpadded))!.bytes, pdfBytes);
    });

    test('names a nameless PDF after its type and falls back to octet-stream', () {
      final pdf = DownloadRequest.parse(message(mime: 'application/pdf', data: pdfBase64))!;
      expect(pdf.name, 'download.pdf');
      final blob = DownloadRequest.parse(message(data: pdfBase64))!;
      expect(blob.name, 'download');
      expect(blob.mimeType, 'application/octet-stream');
    });

    test('rejects anything that is not a bridge message', () {
      expect(DownloadRequest.parse('not json'), isNull);
      expect(DownloadRequest.parse('[]'), isNull);
      expect(DownloadRequest.parse(message(name: 'x.pdf')), isNull);
      expect(DownloadRequest.parse(message(data: '')), isNull);
      expect(DownloadRequest.parse(message(data: 42)), isNull);
      expect(DownloadRequest.parse(message(data: '@@@not-base64@@@')), isNull);
    });

    test('refuses a payload above the size cap without decoding it', () {
      final huge = 'A' * (downloadBridgeMaxBytes * 4 ~/ 3 + 8);
      expect(DownloadRequest.parse(message(data: huge)), isNull);
    });
  });

  group('safeFileName', () {
    test('keeps only the last path segment', () {
      expect(safeFileName('../../etc/passwd', ''), 'passwd');
      expect(safeFileName(r'C:\Users\me\receipt.pdf', ''), 'receipt.pdf');
    });

    test('strips hidden-file dots and control characters', () {
      expect(safeFileName('..hidden', ''), 'hidden');
      expect(safeFileName('re\u0000ceipt<1>.pdf', ''), 're_ceipt_1_.pdf');
    });

    test('adds the extension for the MIME type only when missing', () {
      expect(safeFileName('receipt', 'application/pdf'), 'receipt.pdf');
      expect(safeFileName('receipt.PDF', 'application/pdf'), 'receipt.PDF');
      expect(safeFileName('rows', 'text/csv'), 'rows.csv');
    });

    test('never returns an empty or overlong name', () {
      expect(safeFileName('   ', ''), 'download');
      expect(safeFileName('a' * 300 + '.pdf', '').length, 120);
    });
  });

  group('DownloadRequest.writeTo', () {
    late Directory tmp;
    setUp(() async => tmp = await Directory.systemTemp.createTemp('fc-dl-'));
    tearDown(() => tmp.delete(recursive: true));

    test('writes the bytes under downloads/ and keeps earlier files', () async {
      final r = DownloadRequest.parse(
          message(name: 'receipt.pdf', mime: 'application/pdf', data: pdfBase64))!;
      final first = await r.writeTo(tmp);
      expect(first.path, endsWith('${Platform.pathSeparator}downloads${Platform.pathSeparator}receipt.pdf'));
      expect(await first.readAsBytes(), pdfBytes);

      final second = await r.writeTo(tmp);
      expect(second.path, isNot(first.path));
      expect(second.path, matches(RegExp(r'receipt-\d+\.pdf$')));
      expect(await first.exists(), isTrue);
      expect(await second.readAsBytes(), pdfBytes);
    });
  });

  group('downloadBridgeScript', () {
    test('posts on the channel the native side registers', () {
      expect(downloadBridgeScript, contains('window.$downloadBridgeChannel'));
    });

    test('is guarded against double injection', () {
      expect(downloadBridgeScript, contains('if (window.__fcDownloadBridge) return;'));
    });
  });
}
