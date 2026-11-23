import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:cms_mozambique/src/app_config.dart';
import 'package:cms_mozambique/src/server_switch.dart';

String flagResponse(List<Map<String, Object?>> records) => jsonEncode({
      'ResponseInfo': null,
      'MdmsRes': {
        'MobileApp': {'Settings': records},
      },
    });

/// A local server standing in for the test server's MDMS search.
Future<HttpServer> fakeMdms(
    Future<void> Function(HttpRequest request) handle) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen(handle);
  return server;
}

Uri searchUrlOf(HttpServer server) =>
    Uri.parse('http://${server.address.host}:${server.port}/mdms-v2/v1/_search');

const _prodEmployee = 'https://falacidadao.gov.mz/digit-ui/employee/user/login';
const _prodCitizen = 'https://falacidadao.gov.mz/digit-ui/citizen/login';
const _uatEmployee = 'https://uat.falacidadao.gov.mz/digit-ui/employee/user/login';
const _uatCitizen = 'https://uat.falacidadao.gov.mz/digit-ui/citizen/login';

AppConfig config({bool withTest = true, bool startWithCitizen = true}) =>
    AppConfig.fromJson({
      'url': _prodEmployee,
      'citizenUrl': _prodCitizen,
      'startWithCitizen': startWithCitizen,
      if (withTest) 'testUrl': _uatEmployee,
      if (withTest) 'testCitizenUrl': _uatCitizen,
    });

void main() {
  group('test server config', () {
    test('is on when both test login pages are configured', () {
      final c = config();
      expect(c.hasTestServer, isTrue);
      expect(c.testHost, 'uat.falacidadao.gov.mz');
      expect(c.testStartUrl, _uatCitizen);
      expect(config(startWithCitizen: false).testStartUrl, _uatEmployee);
    });

    test('is off when either test login page is missing or empty', () {
      expect(config(withTest: false).hasTestServer, isFalse);
      expect(
        AppConfig.fromJson({'testCitizenUrl': _uatCitizen}).hasTestServer,
        isFalse,
      );
      expect(
        AppConfig.fromJson({'testUrl': '', 'testCitizenUrl': _uatCitizen})
            .hasTestServer,
        isFalse,
      );
    });

    test('recognises test-server pages by host only', () {
      final c = config();
      expect(c.isTestPage('$_uatCitizen/otp'), isTrue);
      expect(c.isTestPage('https://uat.falacidadao.gov.mz/digit-ui/citizen/pgr/complaints'), isTrue);
      expect(c.isTestPage(_prodCitizen), isFalse);
      expect(c.isTestPage('https://falacidadao.gov.mz/?next=uat.falacidadao.gov.mz'), isFalse);
      expect(c.isTestPage('not a url'), isFalse);
      expect(config(withTest: false).isTestPage(_uatCitizen), isFalse);
    });

    test('maps a login page to its counterpart on the other server', () {
      final c = config();
      expect(c.testLoginFor(_prodEmployee), _uatEmployee);
      expect(c.testLoginFor(_prodCitizen), _uatCitizen);
      expect(c.testLoginFor('$_prodCitizen/otp'), _uatCitizen);
      expect(c.loginFor('https://uat.falacidadao.gov.mz/digit-ui/employee/pgr/inbox'), _prodEmployee);
      expect(c.loginFor('https://uat.falacidadao.gov.mz/digit-ui/citizen/pgr/complaints'), _prodCitizen);
    });
  });

  group('remote flag', () {
    test('reads the flag from the test server MDMS for the test tenant', () {
      final c = config();
      expect(c.testFlagUrl.toString(), 'https://uat.falacidadao.gov.mz/mdms-v2/v1/_search');
      expect(c.testTenantId, 'mz');
      expect(AppConfig.fromJson({'testTenantId': 'mz.maputo'}).testTenantId, 'mz.maputo');
    });

    test('is off only for a TEST_SERVER_SWITCH record with enabled false', () {
      expect(serverSwitchFlagIsOn(flagResponse([
        {'code': 'TEST_SERVER_SWITCH', 'enabled': false},
      ])), isFalse);
      expect(serverSwitchFlagIsOn(flagResponse([
        {'code': 'TEST_SERVER_SWITCH', 'enabled': true},
      ])), isTrue);
      expect(serverSwitchFlagIsOn(flagResponse([
        {'code': 'SOMETHING_ELSE', 'enabled': false},
      ])), isTrue);
    });

    test('is on by default: no record, or a response that is not MDMS', () {
      expect(serverSwitchFlagIsOn('{"ResponseInfo":null,"MdmsRes":{}}'), isTrue);
      expect(serverSwitchFlagIsOn('{"Errors":[{"code":"X"}]}'), isTrue);
      expect(serverSwitchFlagIsOn('<html>502 Bad Gateway</html>'), isTrue);
      expect(serverSwitchFlagIsOn('[]'), isTrue);
    });

    test('posts an MDMS search and follows the answer', () async {
      Map<String, dynamic>? sent;
      final server = await fakeMdms((request) async {
        sent = jsonDecode(await utf8.decoder.bind(request).join()) as Map<String, dynamic>;
        request.response
          ..headers.contentType = ContentType.json
          ..write(flagResponse([
            {'code': 'TEST_SERVER_SWITCH', 'enabled': false},
          ]));
        await request.response.close();
      });
      addTearDown(server.close);

      expect(await fetchServerSwitchFlag(searchUrlOf(server), 'mz'), isFalse);
      final criteria = sent!['MdmsCriteria'] as Map<String, dynamic>;
      expect(criteria['tenantId'], 'mz');
      expect(criteria['moduleDetails'], [
        {
          'moduleName': 'MobileApp',
          'masterDetails': [
            {'name': 'Settings'},
          ],
        },
      ]);
    });

    test('stays on when the server has no record for it', () async {
      final empty = await fakeMdms((request) async {
        request.response.write('{"ResponseInfo":null,"MdmsRes":{}}');
        await request.response.close();
      });
      addTearDown(empty.close);
      expect(await fetchServerSwitchFlag(searchUrlOf(empty), 'mz'), isTrue);
    });

    test('stays on with a server error, a slow server or no server', () async {
      final failing = await fakeMdms((request) async {
        request.response.statusCode = HttpStatus.internalServerError;
        request.response.write(flagResponse([
          {'code': 'TEST_SERVER_SWITCH', 'enabled': false},
        ]));
        await request.response.close();
      });
      addTearDown(failing.close);
      expect(await fetchServerSwitchFlag(searchUrlOf(failing), 'mz'), isTrue);

      final slow = await fakeMdms((request) async {
        await Future<void>.delayed(const Duration(seconds: 2));
        request.response.write(flagResponse([
          {'code': 'TEST_SERVER_SWITCH', 'enabled': false},
        ]));
        await request.response.close();
      });
      addTearDown(() => slow.close(force: true));
      expect(
        await fetchServerSwitchFlag(searchUrlOf(slow), 'mz',
            timeout: const Duration(milliseconds: 300)),
        isTrue,
      );

      final gone = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final goneUrl = searchUrlOf(gone);
      await gone.close();
      expect(await fetchServerSwitchFlag(goneUrl, 'mz'), isTrue);
    });
  });

  group('ServerSwitchText', () {
    test('is Portuguese on a Portuguese phone and English otherwise', () {
      expect(ServerSwitchText.forLanguage('pt').switchAction, 'Mudar');
      expect(ServerSwitchText.forLanguage('PT').banner, startsWith('SERVIDOR DE TESTE'));
      expect(ServerSwitchText.forLanguage('en').switchAction, 'Switch');
      expect(ServerSwitchText.forLanguage('fr').banner, startsWith('TEST SERVER'));
      expect(ServerSwitchText.forLanguage('').cancel, 'Cancel');
    });
  });

  group('serverSwitchScript', () {
    test('posts the request the native side listens for on its channel', () {
      expect(serverSwitchScript, contains('window.$serverSwitchChannel'));
      expect(serverSwitchScript, contains("postMessage('$serverSwitchRequest')"));
    });

    test('is guarded against a second injection', () {
      expect(serverSwitchScript, contains('if (window.__fcServerSwitch) return;'));
    });
  });
}
