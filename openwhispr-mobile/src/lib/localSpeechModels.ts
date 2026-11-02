import { isLocalModelKey, type LocalModelKey } from './localModelCatalog';
import type { UserConfig } from '@/types';

export type MlKitModelKey = 'mlkit-basic' | 'mlkit-advanced';
export type LocalSpeechModelKey = LocalModelKey | MlKitModelKey;

export const ML_KIT_TITLES: Record<MlKitModelKey, string> = {
  'mlkit-basic': 'ML Kit Basic',
  'mlkit-advanced': 'ML Kit Advanced',
};

export function isMlKitModelKey(value: unknown): value is MlKitModelKey {
  return value === 'mlkit-basic' || value === 'mlkit-advanced';
}

export function isLocalSpeechModelKey(value: unknown): value is LocalSpeechModelKey {
  return isLocalModelKey(value) || isMlKitModelKey(value);
}

export function mlKitMode(model: MlKitModelKey): 'basic' | 'advanced' {
  return model === 'mlkit-basic' ? 'basic' : 'advanced';
}

// ML Kit requires one explicit locale. Never guess English for auto-detect or a multilingual
// selection. Preserve regional choices; the native SDK decides whether that locale is supported.
export function mlKitLocale(
  config: Pick<UserConfig, 'preferredLanguage' | 'languages'> | null,
): string | null {
  const languages = config?.preferredLanguage
    ? [config.preferredLanguage]
    : [...new Set(config?.languages ?? [])];
  if (languages.length !== 1 || !languages[0] || languages[0] === 'auto') return null;
  const language = languages[0];
  const defaults: Record<string, string> = {
    en: 'en-US',
    de: 'de-DE',
    es: 'es-ES',
    fr: 'fr-FR',
    hi: 'hi-IN',
    it: 'it-IT',
    ja: 'ja-JP',
    ko: 'ko-KR',
    pl: 'pl-PL',
    pt: 'pt-BR',
    ru: 'ru-RU',
    tr: 'tr-TR',
    vi: 'vi-VN',
    ar: 'ar-SA',
    da: 'da-DK',
    id: 'id-ID',
    nl: 'nl-NL',
    sv: 'sv-SE',
    th: 'th-TH',
    zh: 'cmn-Hans-CN',
    'zh-CN': 'cmn-Hans-CN',
    'zh-TW': 'cmn-Hant-TW',
  };
  return defaults[language] ?? language;
}
