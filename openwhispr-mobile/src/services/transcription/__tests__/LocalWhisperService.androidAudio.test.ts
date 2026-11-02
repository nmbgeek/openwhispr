jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('whisper.rn', () => ({ initWhisper: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: async () => ({ exists: true, size: 100 }),
  readDirectoryAsync: async () => ['base.bin'],
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('../../../../modules/android-speech/src', () => ({
  AndroidSpeech: {
    convertToWav: jest.fn(async () => 'file:///cache/decoded.wav'),
  },
}));

import { initWhisper } from 'whisper.rn';
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidSpeech } from '../../../../modules/android-speech/src';
import { LocalWhisperService } from '../LocalWhisperService';

const mockTranscribe = jest.fn();
beforeEach(async () => {
  await LocalWhisperService.cleanup();
  jest.clearAllMocks();
  jest.mocked(initWhisper).mockResolvedValue({
    transcribe: mockTranscribe,
    release: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof initWhisper>>);
  mockTranscribe.mockReturnValue({
    promise: Promise.resolve({ result: 'offline speech', segments: [] }),
  });
  jest.mocked(AndroidSpeech.convertToWav).mockResolvedValue('file:///cache/decoded.wav');
});

test('decodes Android M4A before Whisper and deletes only its temporary WAV', async () => {
  const result = await LocalWhisperService.transcribe('file:///recordings/original.m4a');
  expect(AndroidSpeech.convertToWav).toHaveBeenCalledWith('file:///recordings/original.m4a');
  expect(mockTranscribe).toHaveBeenCalledWith('file:///cache/decoded.wav', expect.any(Object));
  expect(result.text).toBe('offline speech');
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/decoded.wav', {
    idempotent: true,
  });
});

test('inference failure also reclaims the decoded WAV and preserves the source recording', async () => {
  mockTranscribe.mockImplementation(() => ({
    promise: Promise.reject(new Error('decode failed')),
  }));
  await expect(LocalWhisperService.transcribe('file:///recordings/original.m4a')).rejects.toThrow(
    'decode failed',
  );
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/decoded.wav', {
    idempotent: true,
  });
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
    'file:///recordings/original.m4a',
    expect.anything(),
  );
});

test('conversion failures stop inference without deleting the original', async () => {
  jest.mocked(AndroidSpeech.convertToWav).mockRejectedValue(new Error('Unsupported format'));
  await expect(LocalWhisperService.transcribe('file:///recordings/original.m4a')).rejects.toThrow(
    'Unsupported format',
  );
  expect(mockTranscribe).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});
