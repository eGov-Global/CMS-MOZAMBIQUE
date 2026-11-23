import 'dart:convert';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter/material.dart';

class AppConfig {
  final String appName;
  final String url;
  final String citizenUrl;
  final String logoAsset;
  final Color primaryColor;
  final bool allowMixedContent;
  final bool javascriptEnabled;
  final bool showAppBar;
  final bool pullToRefresh;
  final bool startWithCitizen;

  /// Employee and citizen login pages of the test (UAT) server behind the
  /// hidden server switch (see server_switch.dart). Both absent → no switch.
  final String? testUrl;
  final String? testCitizenUrl;

  /// State tenant of the test server, where the switch's on/off flag lives.
  final String testTenantId;

  String get startUrl => startWithCitizen ? citizenUrl : url;

  bool get hasTestServer =>
      (testUrl?.isNotEmpty ?? false) && (testCitizenUrl?.isNotEmpty ?? false);

  String get testStartUrl => startWithCitizen ? testCitizenUrl! : testUrl!;

  String get testHost => hasTestServer ? Uri.parse(testCitizenUrl!).host : '';

  /// MDMS search on the test server, read for the switch's on/off flag.
  Uri get testFlagUrl {
    final base = Uri.parse(testCitizenUrl!);
    return Uri(
      scheme: base.scheme,
      host: base.host,
      port: base.hasPort ? base.port : null,
      path: '/mdms-v2/v1/_search',
    );
  }

  /// Whether [pageUrl] is served by the test server.
  bool isTestPage(String pageUrl) =>
      hasTestServer && Uri.tryParse(pageUrl)?.host == testHost;

  /// The login page on the test server matching the one at [pageUrl]:
  /// employee login for an employee page, citizen login otherwise.
  String testLoginFor(String pageUrl) =>
      _isEmployeePage(pageUrl) ? testUrl! : testCitizenUrl!;

  /// The production login page matching the one at [pageUrl].
  String loginFor(String pageUrl) =>
      _isEmployeePage(pageUrl) ? url : citizenUrl;

  static bool _isEmployeePage(String pageUrl) =>
      Uri.tryParse(pageUrl)?.path.contains('/employee/') ?? false;

  const AppConfig({
    required this.appName,
    required this.url,
    required this.citizenUrl,
    required this.logoAsset,
    required this.primaryColor,
    required this.allowMixedContent,
    required this.javascriptEnabled,
    required this.showAppBar,
    required this.pullToRefresh,
    required this.startWithCitizen,
    this.testUrl,
    this.testCitizenUrl,
    this.testTenantId = 'mz',
  });

  static Future<AppConfig> load() async {
    final raw = await rootBundle.loadString('assets/config/app_config.json');
    return AppConfig.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

  factory AppConfig.fromJson(Map<String, dynamic> json) {
    return AppConfig(
      appName: json['appName'] as String? ?? 'Fala Cidadão',
      url: json['url'] as String? ??
          'https://falacidadao.gov.mz/digit-ui/employee/user/login',
      citizenUrl: json['citizenUrl'] as String? ??
          'https://falacidadao.gov.mz/digit-ui/citizen/login',
      logoAsset: json['logoAsset'] as String? ?? 'assets/icons/app_icon.png',
      primaryColor: _parseHex(json['primaryColorHex'] as String? ?? '#204F37'),
      allowMixedContent: json['allowMixedContent'] as bool? ?? false,
      javascriptEnabled: json['javascriptEnabled'] as bool? ?? true,
      showAppBar: json['showAppBar'] as bool? ?? false,
      pullToRefresh: json['pullToRefresh'] as bool? ?? true,
      startWithCitizen: json['startWithCitizen'] as bool? ?? true,
      testUrl: json['testUrl'] as String?,
      testCitizenUrl: json['testCitizenUrl'] as String?,
      testTenantId: json['testTenantId'] as String? ?? 'mz',
    );
  }

  static Color _parseHex(String hex) {
    var v = hex.replaceFirst('#', '');
    if (v.length == 6) v = 'FF$v';
    return Color(int.parse(v, radix: 16));
  }
}
