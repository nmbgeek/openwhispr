import * as FileSystem from 'expo-file-system/legacy';
import { retainTranscriptAudio } from '@/lib/transcriptAudio';
import { useTranscriptStore } from '../useTranscriptStore';
import { StorageService } from '@/services/storage/StorageService';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 32000 })),
  copyAsync: jest.fn(async () => {
    throw new Error('Persistent copy failure');
  }),
  makeDirectoryAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    saveTranscripts: jest.fn(async () => undefined),
    getTranscripts: jest.fn(async () => []),
  },
}));
jest.mock('@/lib/keyboardInferenceRoute', () => ({
  listPendingProviderRecoveryJobs: () => [],
  clearKeyboardProviderRecovery: jest.fn(),
}));
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { getItem: () => null },
}));
jest.mock('../../../modules/audio-tools/src', () => ({
  AudioTools: { isAvailable: () => false, cleanup: async () => undefined },
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: jest.fn(async () => ({
    text: 'Recovered speech',
    originalText: 'Recovered speech',
    transcription: { text: 'Recovered speech', provider: 'local', duration: 1 },
  })),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'private' }) },
}));
jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTextInference: () => ({}),
  snapshotTranscriptionJob: () => ({ provider: 'local' }),
}));
jest.mock('@/lib/appsflyer', () => ({ logTranscriptionCompleted: jest.fn() }));

test('native managed WAV becomes retryable through the real retention helper and store without copying', async () => {
  const audioUrl = 'file:///cache/transcript-audio/live-speech-native.wav';
  useTranscriptStore.setState({
    transcripts: [],
    currentTranscript: null,
    isLoading: false,
    isLoaded: true,
    error: null,
  });
  // The hook uses this real helper first; the real store independently checks ownership again.
  const retained = await retainTranscriptAudio(audioUrl, { transcriptId: 'live-failure' });
  await useTranscriptStore.getState().addFailedTranscript({
    id: 'live-failure',
    audioUrl: retained,
    audioFileName: 'live.wav',
    audioMimeType: 'audio/wav',
    provider: 'local',
    requestContext: 'recording',
    errorMessage: 'Recognizer interrupted',
  });
  expect(StorageService.saveTranscripts).toHaveBeenCalledWith([
    expect.objectContaining({ id: 'live-failure', status: 'failed', audioUrl }),
  ]);
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  await useTranscriptStore.getState().retryTranscript('live-failure');
  expect(transcribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ audioUri: audioUrl, provider: 'local' }),
  );
  expect(useTranscriptStore.getState().transcripts[0]).toMatchObject({
    status: 'completed',
    text: 'Recovered speech',
    audioUrl: undefined,
  });
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(audioUrl, { idempotent: true });
});
