import { describe, it, expect, afterEach } from 'vitest';
import { resolveInitialLocale } from './i18nProvider';

// The Studio's boot locale mirrors the esbuild portal: index.html loads the
// env's /digit-ui/globalConfigs.js and the default derives from
// LOCALE_DEFAULT/LOCALE_REGION. These tests pin the mapping rules — exact
// match first, then language-prefix, then the en_IN fallback.

const setConfig = (values: Record<string, unknown> | null) => {
  (window as unknown as Record<string, unknown>).globalConfigs = values
    ? { getConfig: (k: string) => values[k] }
    : undefined;
};

afterEach(() => setConfig(null));

describe('resolveInitialLocale', () => {
  it('falls back to en_IN when no globalConfigs script is loaded', () => {
    setConfig(null);
    expect(resolveInitialLocale()).toBe('en_IN');
  });

  it('uses the exact locale when the portal default exists in the Studio list', () => {
    setConfig({ LOCALE_DEFAULT: 'hi', LOCALE_REGION: 'IN' });
    expect(resolveInitialLocale()).toBe('hi_IN');
  });

  it('uses pt_PT exactly, the code the portal and chatbot use', () => {
    setConfig({ LOCALE_DEFAULT: 'pt', LOCALE_REGION: 'PT' });
    expect(resolveInitialLocale()).toBe('pt_PT');
  });

  it('still resolves pt_BR exactly for a Brazilian deployment', () => {
    setConfig({ LOCALE_DEFAULT: 'pt', LOCALE_REGION: 'BR' });
    expect(resolveInitialLocale()).toBe('pt_BR');
  });

  it('prefers pt_PT when only the language is configured', () => {
    setConfig({ LOCALE_DEFAULT: 'pt' });
    expect(resolveInitialLocale()).toBe('pt_PT');
  });

  it('maps a language with no region config by prefix too', () => {
    setConfig({ LOCALE_DEFAULT: 'fr' });
    expect(resolveInitialLocale()).toBe('fr_FR');
  });

  it('falls back to en_IN for a language the Studio does not ship', () => {
    setConfig({ LOCALE_DEFAULT: 'sw', LOCALE_REGION: 'KE' });
    expect(resolveInitialLocale()).toBe('en_IN');
  });

  it('ignores non-string/garbage config values', () => {
    setConfig({ LOCALE_DEFAULT: 42, LOCALE_REGION: {} });
    expect(resolveInitialLocale()).toBe('en_IN');
  });

  it('survives a getConfig that throws', () => {
    (window as unknown as Record<string, unknown>).globalConfigs = {
      getConfig: () => { throw new Error('boom'); },
    };
    expect(resolveInitialLocale()).toBe('en_IN');
  });
});
