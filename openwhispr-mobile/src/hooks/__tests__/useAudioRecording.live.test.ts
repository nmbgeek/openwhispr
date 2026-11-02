import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useAudioRecording } from '../useAudioRecording';
import { AndroidSpeech, type AndroidLiveSpeechEvent } from '../../../modules/android-speech/src';
import { completeRecordedTranscription, transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { retainTranscriptAudio } from '@/lib/transcriptAudio';

jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native');
  rn.Platform.OS = 'android';
  return rn;
});
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  deleteAsync: jest.fn(async () => undefined),
}));
const mockAddTranscript = jest.fn(async () => undefined);
const mockAddFailedTranscript = jest.fn(async () => undefined);
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: () => 'test-id',
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: mockAddFailedTranscript }),
}));
let mockModel = 'mlkit-basic';
let mockRoute = { provider: 'local', cleanupRoute: { mode: 'local', scope: 'cleanup' } };
const mockConfig = { preferredLanguage: 'en-US' };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: mockConfig }) },
}));
jest.mock('@/lib/inferenceRouting', () => ({
  getPickedLocalModel: () => mockModel,
  snapshotTranscriptionJob: () => mockRoute,
  snapshotTextInference: () => ({}),
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({
  completeRecordedTranscription: jest.fn(),
  transcribeAndCleanup: jest.fn(),
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  isLocalModelMissingError: () => false,
}));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: jest.fn(async () => null),
  createNoSpeechError: () => new Error('No speech detected'),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(async () => 'file:///retained.wav'),
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
}));
jest.mock('@/lib/usageLimitError', () => ({ isUsageLimitError: () => false }));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));
jest.mock('@/lib/uuid', () => ({ randomUUID: () => 'session' }));
const mockRecorder = {
  isRecording: false,
  uri: 'file:///batch.m4a',
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
};
const mockAudioModule = {
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  requestNotificationPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => undefined),
};
jest.mock('expo-audio', () => ({ useAudioRecorder: () => mockRecorder }));
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({ AudioModule: mockAudioModule }),
  isExpoAudioAvailable: () => true,
  getDefaultRecorderOptions: () => ({}),
}));
let mockListener: ((event: AndroidLiveSpeechEvent) => void) | null = null;
const mockRemoveListener = jest.fn();
jest.mock('../../../modules/android-speech/src', () => ({
  AndroidSpeech: {
    isLiveAvailable: jest.fn(() => true),
    getStatus: jest.fn(async () => ({ status: 'available' })),
    startLive: jest.fn(async () => undefined),
    stopLive: jest.fn(async () => ({
      text: 'Final words.',
      fileUri: 'file:///live.wav',
      durationMs: 2400,
    })),
    cancelLive: jest.fn(async () => undefined),
    addLiveListener: (listener: (event: AndroidLiveSpeechEvent) => void) => {
      mockListener = listener;
      return { remove: mockRemoveListener };
    },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockModel = 'mlkit-basic';
  mockConfig.preferredLanguage = 'en-US';
  mockRoute = { provider: 'local', cleanupRoute: { mode: 'local', scope: 'cleanup' } };
  mockRecorder.isRecording = false;
  jest.mocked(AndroidSpeech.isLiveAvailable).mockReturnValue(true);
  jest
    .mocked(AndroidSpeech.stopLive)
    .mockResolvedValue({ text: 'Final words.', fileUri: 'file:///live.wav', durationMs: 2400 });
  jest.mocked(completeRecordedTranscription).mockImplementation(async (_request, response) => ({
    text: response.text,
    originalText: response.text,
    transcription: response,
    cleanupApplied: false,
    fusedCleanup: false,
  }));
  jest.mocked(transcribeAndCleanup).mockResolvedValue({
    text: 'Batch.',
    originalText: 'Batch.',
    transcription: { text: 'Batch.', provider: 'local', duration: 1 },
    cleanupApplied: false,
    fusedCleanup: false,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('replaces live partials and saves only final speech once through cleanup, without a second transcription', async () => {
  const onComplete = jest.fn();
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true, onComplete }));
  await act(async () => {
    await result.current.startRecording();
  });
  expect(AndroidSpeech.startLive).toHaveBeenCalledWith('live-session', 'basic', 'en-US');
  expect(mockRecorder.record).not.toHaveBeenCalled();
  act(() => {
    mockListener?.({
      type: 'transcript',
      sessionId: 'live-session',
      text: 'Hello',
      isFinal: false,
    });
  });
  act(() => {
    mockListener?.({
      type: 'transcript',
      sessionId: 'live-session',
      text: 'Hello there',
      isFinal: false,
    });
  });
  expect(result.current.currentText).toBe('Hello there');
  act(() => {
    mockListener?.({ type: 'transcript', sessionId: 'stale', text: 'Wrong', isFinal: true });
  });
  expect(result.current.currentText).toBe('Hello there');
  mockModel = 'mlkit-advanced';
  mockConfig.preferredLanguage = 'fr-FR';
  mockRoute = { provider: 'cloud', cleanupRoute: { mode: 'openwhispr', scope: 'cleanup' } };
  await act(async () => {
    await Promise.all([result.current.stopRecording(), result.current.stopRecording()]);
  });
  expect(AndroidSpeech.stopLive).toHaveBeenCalledTimes(1);
  expect(completeRecordedTranscription).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'local',
      language: 'en-US',
      cleanupRoute: { mode: 'local', scope: 'cleanup' },
    }),
    expect.objectContaining({ text: 'Final words.', endpoint: 'mlkit-basic', duration: 2.4 }),
    expect.anything(),
  );
  expect(transcribeAndCleanup).not.toHaveBeenCalled();
  expect(mockAddTranscript).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith('Final words.');
});

test('a recognition error retains its audio as a failed row and never saves partial text', async () => {
  const onComplete = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({ liveTranscription: true, onComplete, onError }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  act(() => {
    mockListener?.({
      type: 'transcript',
      sessionId: 'live-session',
      text: 'Incomplete',
      isFinal: false,
    });
  });
  jest.mocked(AndroidSpeech.stopLive).mockResolvedValue({
    text: 'Incomplete',
    fileUri: 'file:///live.wav',
    durationMs: 200,
    error: { code: 'FAILED', message: 'Recognition failed' },
  });
  await act(async () => {
    await expect(result.current.stopRecording()).rejects.toThrow('Recognition failed');
  });
  expect(mockAddFailedTranscript).toHaveBeenCalledWith(
    expect.objectContaining({ audioUrl: 'file:///retained.wav', provider: 'local' }),
  );
  expect(completeRecordedTranscription).not.toHaveBeenCalled();
  expect(mockAddTranscript).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
});

test('discard and unmount close the live microphone and ignore late events', async () => {
  const { result, unmount } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    await result.current.cancelRecording();
  });
  act(() => {
    mockListener?.({ type: 'transcript', sessionId: 'live-session', text: 'Late', isFinal: true });
  });
  expect(result.current.currentText).toBe('');
  expect(AndroidSpeech.cancelLive).toHaveBeenCalledWith('live-session');
  expect(mockRemoveListener).toHaveBeenCalled();
  await act(async () => {
    await result.current.startRecording();
  });
  unmount();
  expect(AndroidSpeech.cancelLive).toHaveBeenCalledTimes(2);
  expect(mockAddTranscript).not.toHaveBeenCalled();
});

test('backgrounding discards a live session instead of promising background speech', async () => {
  const listener = jest.spyOn(AppState, 'addEventListener');
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  const callback = listener.mock.calls.find(([event]) => event === 'change')?.[1];
  await act(async () => {
    callback?.('background');
  });
  await waitFor(() => expect(result.current.isRecording).toBe(false));
  expect(AndroidSpeech.cancelLive).toHaveBeenCalledWith('live-session');
  expect(mockAddTranscript).not.toHaveBeenCalled();
});

test('Whisper preserves the Expo capture and batch transcription path', async () => {
  mockModel = 'whisper-base';
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    await result.current.stopRecording();
  });
  expect(mockRecorder.record).toHaveBeenCalledTimes(1);
  expect(AndroidSpeech.startLive).not.toHaveBeenCalled();
  expect(transcribeAndCleanup).toHaveBeenCalledTimes(1);
  expect(completeRecordedTranscription).not.toHaveBeenCalled();
});

test('an older native build refuses live speech clearly before opening its mic', async () => {
  jest.mocked(AndroidSpeech.isLiveAvailable).mockReturnValue(false);
  const onError = jest.fn();
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true, onError }));
  await act(async () => {
    await expect(result.current.startRecording()).rejects.toThrow('updated Android app');
  });
  expect(AndroidSpeech.startLive).not.toHaveBeenCalled();
  expect(mockRecorder.record).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
});

test('an error event stops capture and keeps audio, even if native returns nonempty final text', async () => {
  const onComplete = jest.fn();
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true, onComplete }));
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    mockListener?.({
      type: 'error',
      sessionId: 'live-session',
      message: 'Recognizer interrupted',
      code: 'INTERRUPTED',
    });
  });
  await waitFor(() => expect(mockAddFailedTranscript).toHaveBeenCalledTimes(1));
  expect(AndroidSpeech.stopLive).toHaveBeenCalledTimes(1);
  expect(mockAddTranscript).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
});

test('abandoning a pending stop deletes the WAV handed back later without writing history', async () => {
  let resolveStop:
    | ((result: Awaited<ReturnType<typeof AndroidSpeech.stopLive>>) => void)
    | undefined;
  jest.mocked(AndroidSpeech.stopLive).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStop = resolve;
      }),
  );
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  let stopped: Promise<void> | undefined;
  act(() => {
    stopped = result.current.stopRecording();
  });
  await act(async () => {
    await result.current.cancelRecording();
    resolveStop?.({ text: 'Late words', fileUri: 'file:///late.wav', durationMs: 1000 });
    await stopped;
  });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///late.wav', { idempotent: true });
  expect(completeRecordedTranscription).not.toHaveBeenCalled();
  expect(mockAddTranscript).not.toHaveBeenCalled();
});

test.each(['cloud', 'byok'])(
  'preserves Expo capture for %s even when live speech is opted in',
  async (provider) => {
    mockRoute = { provider, cleanupRoute: { mode: 'local', scope: 'cleanup' } };
    const { result } = renderHook(() => useAudioRecording({ liveTranscription: true }));
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      await result.current.stopRecording();
    });
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
    expect(AndroidSpeech.startLive).not.toHaveBeenCalled();
    expect(transcribeAndCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      expect.anything(),
    );
  },
);

test('unmount during native start cancels the pending session and never opens a live UI afterward', async () => {
  let resolveStart: (() => void) | undefined;
  jest.mocked(AndroidSpeech.startLive).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  let started: Promise<void> | undefined;
  act(() => {
    started = result.current.startRecording();
  });
  await waitFor(() => expect(AndroidSpeech.startLive).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => {
    resolveStart?.();
    await started;
  });
  expect(AndroidSpeech.cancelLive).toHaveBeenCalledWith('live-session');
  expect(mockRecorder.record).not.toHaveBeenCalled();
  expect(mockAddTranscript).not.toHaveBeenCalled();
});

test('raw-audio callers remain opted out even when dictation selects ML Kit', async () => {
  const { result } = renderHook(() => useAudioRecording());
  await act(async () => {
    await result.current.startRecording();
  });
  mockRecorder.isRecording = true;
  let uri: string | null = null;
  await act(async () => {
    uri = await result.current.stopRecordingRaw();
  });
  expect(uri).toBe('file:///batch.m4a');
  expect(AndroidSpeech.startLive).not.toHaveBeenCalled();
  expect(transcribeAndCleanup).not.toHaveBeenCalled();
});

test.each(['final', 'failed'])(
  'a claimed stop preserves %s history after navigation without UI callbacks',
  async (outcome) => {
    let resolveStop:
      | ((result: Awaited<ReturnType<typeof AndroidSpeech.stopLive>>) => void)
      | undefined;
    jest.mocked(AndroidSpeech.stopLive).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStop = resolve;
        }),
    );
    const onComplete = jest.fn();
    const onError = jest.fn();
    const { result, unmount } = renderHook(() =>
      useAudioRecording({ liveTranscription: true, onComplete, onError }),
    );
    await act(async () => {
      await result.current.startRecording();
    });
    let stopped: Promise<void> | undefined;
    act(() => {
      stopped = result.current.stopRecording();
    });
    unmount();
    await act(async () => {
      resolveStop?.({
        text: 'Final words',
        fileUri: 'file:///committed.wav',
        durationMs: 1000,
        ...(outcome === 'failed'
          ? { error: { code: 'FAILED', message: 'Recognition failed' } }
          : {}),
      });
      await stopped?.catch(() => undefined);
    });
    expect(AndroidSpeech.cancelLive).not.toHaveBeenCalled();
    expect(outcome === 'failed' ? mockAddFailedTranscript : mockAddTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ audioUrl: 'file:///retained.wav' }),
    );
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(
      'file:///committed.wav',
      expect.anything(),
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  },
);

test('backgrounding after Stop does not discard its committed recording', async () => {
  let resolveStop:
    | ((result: Awaited<ReturnType<typeof AndroidSpeech.stopLive>>) => void)
    | undefined;
  jest.mocked(AndroidSpeech.stopLive).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStop = resolve;
      }),
  );
  const listener = jest.mocked(AppState.addEventListener);
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  let stopped: Promise<void> | undefined;
  act(() => {
    stopped = result.current.stopRecording();
  });
  const callback = listener.mock.calls.find(([event]) => event === 'change')?.[1];
  await act(async () => {
    callback?.('background');
    resolveStop?.({ text: 'Final words', fileUri: 'file:///committed.wav', durationMs: 1000 });
    await stopped;
  });
  expect(AndroidSpeech.cancelLive).not.toHaveBeenCalled();
  expect(mockAddTranscript).toHaveBeenCalledTimes(1);
});

test('a retention copy failure preserves the original WAV on a retryable failed row', async () => {
  jest.mocked(retainTranscriptAudio).mockRejectedValueOnce(new Error('Not enough storage'));
  const { result } = renderHook(() => useAudioRecording({ liveTranscription: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    await expect(result.current.stopRecording()).rejects.toThrow('Not enough storage');
  });
  expect(mockAddFailedTranscript).toHaveBeenCalledWith(
    expect.objectContaining({ audioUrl: 'file:///live.wav', audioMimeType: 'audio/wav' }),
  );
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///live.wav', expect.anything());
  expect(mockAddTranscript).not.toHaveBeenCalled();
});
