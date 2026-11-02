import { isLocalSpeechModelKey, mlKitLocale } from '../localSpeechModels';
import { getLocalModelCatalog } from '../localModelCatalog';

test('ML Kit requires an explicit single language and preserves its locale', () => {
  expect(mlKitLocale(null)).toBeNull();
  expect(mlKitLocale({ preferredLanguage: 'auto', languages: ['en-US'] })).toBeNull();
  expect(mlKitLocale({ languages: ['en-US', 'fr-FR'] })).toBeNull();
  expect(mlKitLocale({ preferredLanguage: 'en-GB', languages: ['fr-FR'] })).toBe('en-GB');
  expect(mlKitLocale({ languages: ['en'] })).toBe('en-US');
  expect(mlKitLocale({ languages: ['zh-CN'] })).toBe('cmn-Hans-CN');
});

test('speech selections include optional ML Kit without changing downloadable model keys', () => {
  expect(isLocalSpeechModelKey('mlkit-basic')).toBe(true);
  expect(isLocalSpeechModelKey('mlkit-advanced')).toBe(true);
  expect(isLocalSpeechModelKey('whisper-base')).toBe(true);
  expect(isLocalSpeechModelKey('cloud')).toBe(false);
});

test('devices without Parakeet recommend the supported Whisper model for English', () => {
  const catalog = getLocalModelCatalog(['en'], {
    parakeetSupported: false,
    parakeetV2Downloaded: false,
    parakeetV3Downloaded: false,
    whisperDownloaded: false,
  });
  expect(catalog).toHaveLength(1);
  expect(catalog[0]).toMatchObject({ key: 'whisper-base', recommended: true });
});
