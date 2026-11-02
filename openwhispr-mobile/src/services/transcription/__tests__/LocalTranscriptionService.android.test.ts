jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../LocalWhisperService', () => ({
  LocalWhisperService: {
    isAvailable: () => true,
    getAvailableModels: async () => [{ name: 'base', downloaded: true }],
    getRecommendedModelForLanguage: async () => 'base',
    transcribe: jest.fn(async () => ({ text: 'whisper', provider: 'local', duration: 1 })),
    cleanup: jest.fn(async () => undefined),
    cancelTranscription: jest.fn(),
  },
}));
jest.mock('../LocalParakeetService', () => ({
  LocalParakeetService: {
    isAvailable: () => false,
    cleanup: jest.fn(async () => undefined),
    cancelTranscription: jest.fn(),
  },
}));
jest.mock('../../../../modules/android-speech/src', () => ({
  AndroidSpeech: {
    isAvailable: () => true,
    getStatus: jest.fn(async () => ({ status: 'available' })),
    transcribe: jest.fn(async () => ({ text: 'ML Kit transcript' })),
    download: jest.fn(),
    cancel: jest.fn(),
  },
}));
const mockConfig: { preferredLanguage: string } = { preferredLanguage: 'en-US' };
jest.mock('../../../store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('../../../lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguages: () => ['en'],
}));

import { AndroidSpeech } from '../../../../modules/android-speech/src';
import { LocalWhisperService } from '../LocalWhisperService';
import { LocalTranscriptionService } from '../LocalTranscriptionService';

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.preferredLanguage = 'en-US';
  jest.mocked(AndroidSpeech.getStatus).mockResolvedValue({ status: 'available' });
});

test('Android automatic uses Whisper, without probing or downloading ML Kit', async () => {
  expect(LocalTranscriptionService.preferredEngineDescriptor().label).toBe('Whisper base');
  const response = await LocalTranscriptionService.transcribe('file:///audio.wav');
  expect(response.endpoint).toBe('whisper-base');
  expect(AndroidSpeech.getStatus).not.toHaveBeenCalled();
  expect(AndroidSpeech.download).not.toHaveBeenCalled();
});

test.each(['mlkit-basic', 'mlkit-advanced'] as const)(
  'explicit %s stays local and checks capability',
  async (model) => {
    const response = await LocalTranscriptionService.transcribe('file:///audio.m4a', { model });
    expect(AndroidSpeech.transcribe).toHaveBeenCalledWith(
      'file:///audio.m4a',
      model === 'mlkit-basic' ? 'basic' : 'advanced',
      'en-US',
    );
    expect(response).toMatchObject({
      text: 'ML Kit transcript',
      endpoint: model,
      provider: 'local',
    });
    expect(LocalWhisperService.transcribe).not.toHaveBeenCalled();
    expect(AndroidSpeech.download).not.toHaveBeenCalled();
  },
);

test('an unavailable selected ML Kit model never silently switches engines or downloads', async () => {
  jest.mocked(AndroidSpeech.getStatus).mockResolvedValue({ status: 'downloadable' });
  await expect(
    LocalTranscriptionService.transcribe('file:///audio.m4a', { model: 'mlkit-advanced' }),
  ).rejects.toThrow('not available');
  await expect(LocalTranscriptionService.isReadyForLanguage('mlkit-advanced')).resolves.toBe(false);
  expect(AndroidSpeech.download).not.toHaveBeenCalled();
  expect(AndroidSpeech.transcribe).not.toHaveBeenCalled();
  expect(LocalWhisperService.transcribe).not.toHaveBeenCalled();
});

test('auto-detect cannot send a guessed locale to ML Kit', async () => {
  mockConfig.preferredLanguage = 'auto';
  await expect(
    LocalTranscriptionService.transcribe('file:///audio.m4a', { model: 'mlkit-basic' }),
  ).rejects.toThrow('Choose one');
  expect(AndroidSpeech.getStatus).not.toHaveBeenCalled();
  expect(AndroidSpeech.transcribe).not.toHaveBeenCalled();
});

test('file word-timing requests explicitly require Whisper', async () => {
  await expect(
    LocalTranscriptionService.transcribe('file:///audio.m4a', {
      model: 'mlkit-basic',
      wordTimestamps: true,
    }),
  ).rejects.toThrow('Select Whisper');
  expect(AndroidSpeech.transcribe).not.toHaveBeenCalled();
});

test('warming never starts an ML Kit download', async () => {
  await LocalTranscriptionService.prepareForLanguage('en', 'mlkit-basic');
  expect(AndroidSpeech.getStatus).not.toHaveBeenCalled();
  expect(AndroidSpeech.download).not.toHaveBeenCalled();
});
