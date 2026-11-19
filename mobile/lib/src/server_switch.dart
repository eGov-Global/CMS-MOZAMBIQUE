import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Disclosed way onto the test (UAT) server, for Google Play's reviewers.
///
/// Citizens sign in with an SMS code sent to a Mozambican number, which a
/// Play reviewer cannot receive, and production is never changed for a
/// review. So the app carries a way onto UAT, where a test number and a fixed
/// code work: ten quick taps on the logo of a login page, then a native
/// confirmation. The choice is never stored — every launch starts on
/// production — and while a UAT page is on screen the app shows a banner that
/// leads back. The steps are written in the Play Console "App access" notes.
/// The team can turn the whole switch on and off remotely (see below).
///
/// The page is given [serverSwitchScript]. It counts taps on the login card's
/// logo (`.bannerHeader img.bannerLogo` on the citizen and employee login
/// pages) and, after ten taps with no pause longer than 1.5 s, posts `switch`
/// on the [serverSwitchChannel] JavaScript channel. Anywhere else a tap
/// resets the count, so ordinary use never gets near it.
///
/// Name of the JavaScript channel the page posts the switch request on.
const String serverSwitchChannel = 'FalaCidadaoServerSwitch';

/// The only message the channel acts on.
const String serverSwitchRequest = 'switch';

/// Remote on/off. The switch is on by default; the team turns it off by
/// adding the [serverSwitchFlagSchema] record [serverSwitchFlagCode] with
/// `"enabled": false` to the test server's MDMS (tools/test_server_switch.py).
/// The flag is read after the ten taps, never during ordinary use. Only that
/// explicit "off" stops the switch: no record, an error or no network leave it
/// on, so Google's reviewers are not locked out by a hiccup.
const String serverSwitchFlagModule = 'MobileApp';
const String serverSwitchFlagMaster = 'Settings';
const String serverSwitchFlagSchema =
    '$serverSwitchFlagModule.$serverSwitchFlagMaster';
const String serverSwitchFlagCode = 'TEST_SERVER_SWITCH';

/// Reads the flag with an MDMS search at [searchUrl] for [tenantId]; false
/// only when the test server answers with the switch turned off.
Future<bool> fetchServerSwitchFlag(
  Uri searchUrl,
  String tenantId, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final client = HttpClient()..connectionTimeout = timeout;
  try {
    final request = await client.postUrl(searchUrl).timeout(timeout);
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({
      'RequestInfo': {'apiId': 'Rainmaker'},
      'MdmsCriteria': {
        'tenantId': tenantId,
        'moduleDetails': [
          {
            'moduleName': serverSwitchFlagModule,
            'masterDetails': [
              {'name': serverSwitchFlagMaster},
            ],
          },
        ],
      },
    }));
    final response = await request.close().timeout(timeout);
    final body = await response.transform(utf8.decoder).join().timeout(timeout);
    return response.statusCode != HttpStatus.ok || serverSwitchFlagIsOn(body);
  } catch (_) {
    return true;
  } finally {
    client.close(force: true);
  }
}

/// Whether an MDMS search response leaves the switch on: everything except a
/// [serverSwitchFlagCode] record whose `enabled` is the boolean `false`.
bool serverSwitchFlagIsOn(String mdmsSearchResponse) {
  Object? decoded;
  try {
    decoded = jsonDecode(mdmsSearchResponse);
  } on FormatException {
    return true;
  }
  if (decoded is! Map<String, dynamic>) return true;
  final res = decoded['MdmsRes'];
  if (res is! Map) return true;
  final module = res[serverSwitchFlagModule];
  if (module is! Map) return true;
  final records = module[serverSwitchFlagMaster];
  if (records is! List) return true;
  return !records.any((r) =>
      r is Map && r['code'] == serverSwitchFlagCode && r['enabled'] == false);
}

/// What the switch shows: Portuguese on a phone set to Portuguese, English
/// everywhere else (Google Play's reviewers included).
class ServerSwitchText {
  final String switchTitle;
  final String switchMessage;
  final String switchAction;
  final String leaveTitle;
  final String leaveMessage;
  final String leaveAction;
  final String cancel;
  final String banner;
  final String bannerSemantics;

  const ServerSwitchText._({
    required this.switchTitle,
    required this.switchMessage,
    required this.switchAction,
    required this.leaveTitle,
    required this.leaveMessage,
    required this.leaveAction,
    required this.cancel,
    required this.banner,
    required this.bannerSemantics,
  });

  factory ServerSwitchText.forLanguage(String languageCode) =>
      languageCode.toLowerCase() == 'pt' ? portuguese : english;

  static const portuguese = ServerSwitchText._(
    switchTitle: 'Servidor de teste',
    switchMessage: 'Mudar para o servidor de teste (UAT)?\n\n'
        'Os dados não são reais e as reclamações feitas aqui não chegam '
        'às instituições. Ao reabrir a aplicação volta ao servidor oficial.',
    switchAction: 'Mudar',
    leaveTitle: 'Servidor oficial',
    leaveMessage: 'Sair do servidor de teste e voltar ao servidor oficial?',
    leaveAction: 'Voltar',
    cancel: 'Cancelar',
    banner: 'SERVIDOR DE TESTE (UAT) · Toque para sair',
    bannerSemantics:
        'Servidor de teste. Toque para voltar ao servidor oficial.',
  );

  static const english = ServerSwitchText._(
    switchTitle: 'Test server',
    switchMessage: 'Switch to the test server (UAT)?\n\n'
        'The data is not real and complaints filed here do not reach the '
        'institutions. Reopening the app returns to the official server.',
    switchAction: 'Switch',
    leaveTitle: 'Official server',
    leaveMessage: 'Leave the test server and go back to the official server?',
    leaveAction: 'Go back',
    cancel: 'Cancel',
    banner: 'TEST SERVER (UAT) · Tap to leave',
    bannerSemantics: 'Test server. Tap to return to the official server.',
  );
}

/// Injected after every production page load. Idempotent: a second injection
/// on the same document is a no-op, so SPA navigations and reloads are safe.
const String serverSwitchScript = r'''
(function () {
  if (window.__fcServerSwitch) return;
  var channel = window.FalaCidadaoServerSwitch;
  if (!channel || typeof channel.postMessage !== 'function') return;
  window.__fcServerSwitch = true;

  var TAPS = 10;
  var MAX_GAP_MS = 1500;
  var count = 0;
  var last = 0;

  // Citizen login (and its code step) or employee login.
  function onLoginPage() {
    return /\/(citizen|employee\/user)\/login(\/|$)/.test(location.pathname);
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var logo = target && target.closest ? target.closest('.bannerHeader img') : null;
    if (!logo || !onLoginPage()) {
      count = 0;
      return;
    }
    var now = Date.now();
    count = now - last > MAX_GAP_MS ? 1 : count + 1;
    last = now;
    if (count >= TAPS) {
      count = 0;
      channel.postMessage('switch');
    }
  }, true);
})();
''';
