import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'src/app_config.dart';
import 'src/splash_screen.dart';
import 'src/web_view_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  runApp(const CmsMozambiqueApp());
}

class CmsMozambiqueApp extends StatelessWidget {
  const CmsMozambiqueApp({super.key});

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<AppConfig>(
      future: AppConfig.load(),
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const MaterialApp(
            debugShowCheckedModeBanner: false,
            home: Scaffold(
              backgroundColor: Colors.white,
              body: Center(child: CircularProgressIndicator()),
            ),
          );
        }
        final config = snapshot.data!;
        return MaterialApp(
          title: config.appName,
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            useMaterial3: true,
            colorSchemeSeed: config.primaryColor,
          ),
          home: _Bootstrap(config: config),
        );
      },
    );
  }
}

class _Bootstrap extends StatefulWidget {
  final AppConfig config;
  const _Bootstrap({required this.config});

  @override
  State<_Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<_Bootstrap> {
  bool _showSplash = true;

  @override
  void initState() {
    super.initState();
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _showSplash = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return _showSplash
        ? SplashScreen(config: widget.config)
        : WebViewScreen(config: widget.config);
  }
}
