import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { RecordingStatus } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { transcribeAndCleanup } from '@/lib/transcribeAndCleanup';
import { retainTranscriptAudio, deleteManagedTranscriptAudio } from '@/lib/transcriptAudio';
import { useAudioRecording } from '../useAudioRecording';

jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native');
  rn.Platform.OS = 'android';
  return rn;
});
jest.mock('@/components/ui/PermissionAlert', () => ({ showPermissionAlert: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(async () => undefined),
}));
const mockAddTranscript = jest.fn(async () => undefined);
const mockAddFailedTranscript = jest.fn(async () => undefined);
jest.mock('@/store/useTranscriptStore', () => ({
  createTranscriptId: () => 'meeting-test',
  useTranscriptStore: (selector: (state: unknown) => unknown) =>
    selector({ addTranscript: mockAddTranscript, addFailedTranscript: mockAddFailedTranscript }),
}));
jest.mock('@/lib/inferenceRouting', () => ({
  snapshotTranscriptionJob: () => ({ provider: 'local' }),
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({ transcribeAndCleanup: jest.fn() }));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  isLocalModelMissingError: () => false,
}));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: jest.fn(),
  createNoSpeechError: jest.fn(),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  retainTranscriptAudio: jest.fn(),
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));

let mockRecordingStatus: ((status: RecordingStatus) => void) | undefined;
const mockRecorder = {
  isRecording: false,
  uri: 'file:///cache/native-recorder.m4a',
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
jest.mock('expo-audio', () => ({
  useAudioRecorder: (_options: unknown, callback?: (status: RecordingStatus) => void) => {
    mockRecordingStatus = callback;
    return mockRecorder;
  },
}));
jest.mock('@/utils/expoAudio', () => ({
  getExpoAudioModule: () => ({ AudioModule: mockAudioModule }),
  isExpoAudioAvailable: () => true,
  getDefaultRecorderOptions: () => ({}),
}));

let appStateChanged: (state: 'active' | 'background' | 'inactive') => void;
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(FileSystem.getInfoAsync)
    .mockResolvedValue({ exists: true, size: 1024 } as Awaited<
      ReturnType<typeof FileSystem.getInfoAsync>
    >);
  jest
    .mocked(retainTranscriptAudio)
    .mockResolvedValue('file:///cache/transcript-audio/retained.m4a');
  mockRecorder.isRecording = false;
  mockRecorder.uri = 'file:///cache/native-recorder.m4a';
  mockRecorder.record.mockImplementation(() => {
    mockRecorder.isRecording = true;
  });
  mockRecorder.stop.mockImplementation(async () => {
    mockRecorder.isRecording = false;
  });
  mockAudioModule.requestNotificationPermissionsAsync.mockResolvedValue({ granted: true });
  mockAudioModule.setAudioModeAsync.mockResolvedValue(undefined);
  const appListeners = new Set<(state: 'active' | 'background' | 'inactive') => void>();
  appStateChanged = (state) => {
    for (const callback of [...appListeners]) callback(state);
  };
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    appListeners.add(callback);
    return { remove: () => appListeners.delete(callback) };
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const finishedStatus = (url: string): RecordingStatus => ({
  id: 'native-recorder',
  isFinished: true,
  hasError: false,
  error: null,
  url,
});

test('background meetings require notification permission before preparing or starting native audio', async () => {
  mockAudioModule.requestNotificationPermissionsAsync.mockResolvedValue({ granted: false });
  const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
  await act(async () => {
    await expect(result.current.startRecording()).rejects.toThrow(/notification permission/i);
  });
  expect(mockRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
  expect(mockRecorder.record).not.toHaveBeenCalled();
});

test('background audio mode failure rejects instead of starting an unprotected recorder', async () => {
  mockAudioModule.setAudioModeAsync.mockRejectedValue(new Error('Foreground service unavailable'));
  const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
  await act(async () => {
    await expect(result.current.startRecording()).rejects.toThrow('Foreground service unavailable');
  });
  expect(mockRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
  expect(mockRecorder.record).not.toHaveBeenCalled();
});

test('Home and screen-lock AppState changes leave an Expo background meeting recording', async () => {
  const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  expect(mockAudioModule.setAudioModeAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      allowsBackgroundRecording: true,
      shouldPlayInBackground: true,
    }),
  );
  await act(async () => {
    appStateChanged('background');
    appStateChanged('inactive');
  });
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  expect(mockRecorder.isRecording).toBe(true);
  expect(result.current.isRecording).toBe(true);
});

test('notification Stop notifies once and raw stop returns the exact finalized URI without another stop', async () => {
  const onRecordingFinished = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({
      allowsBackgroundRecording: true,
      onRecordingFinished,
    }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  const finalizedUri = 'file:///cache/finalized-from-notification.m4a';
  mockRecorder.isRecording = false;
  await act(async () => {
    mockRecordingStatus?.(finishedStatus(finalizedUri));
    mockRecordingStatus?.(finishedStatus(finalizedUri));
  });
  expect(onRecordingFinished).toHaveBeenCalledTimes(1);
  expect(onRecordingFinished).toHaveBeenCalledWith(null);
  let actual: string | null = null;
  await act(async () => {
    actual = await result.current.stopRecordingRaw();
  });
  expect(actual).toBe(finalizedUri);
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  expect(result.current.isRecording).toBe(false);
});

test('native error completion notifies once with an error and preserves its raw URI', async () => {
  const onRecordingFinished = jest.fn();
  const onError = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({
      allowsBackgroundRecording: true,
      onRecordingFinished,
      onError,
    }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    mockRecorder.isRecording = false;
    mockRecordingStatus?.({
      ...finishedStatus('file:///bad.m4a'),
      hasError: true,
      error: 'Microphone disconnected',
    });
  });
  expect(onRecordingFinished).toHaveBeenCalledTimes(1);
  expect(onRecordingFinished).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Microphone disconnected' }),
  );
  expect(onRecordingFinished).not.toHaveBeenCalledWith(null);
  let uri: string | null = null;
  await act(async () => {
    uri = await result.current.stopRecordingRaw();
  });
  expect(uri).toBe('file:///bad.m4a');
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
});

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((accept) => {
    resolve = () => accept(undefined);
  });
  return { promise, resolve };
}

test.each(['cancel', 'background'] as const)(
  '%s during prepare cannot start a background microphone later',
  async (interruption) => {
    const preparing = deferredVoid();
    mockRecorder.prepareToRecordAsync.mockReturnValueOnce(preparing.promise);
    const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.startRecording();
    });
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (interruption === 'cancel') await result.current.cancelRecording();
      else appStateChanged('background');
      preparing.resolve();
      await starting;
    });
    expect(mockRecorder.record).not.toHaveBeenCalled();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(false);
  },
);

test('intentional raw stop and its late native completion do not trigger notification-stop handling', async () => {
  const onRecordingFinished = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({ allowsBackgroundRecording: true, onRecordingFinished }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  const firstUri = mockRecorder.uri;
  await act(async () => {
    await result.current.stopRecordingRaw();
  });
  mockRecorder.uri = 'file:///cache/second-recording.m4a';
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    mockRecordingStatus?.(finishedStatus(firstUri));
  });
  expect(onRecordingFinished).not.toHaveBeenCalled();
  expect(result.current.isRecording).toBe(true);
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
});

test('native error completion drains the microphone before notifying the meeting owner', async () => {
  const drained = deferredVoid();
  mockRecorder.stop.mockReturnValueOnce(drained.promise);
  const onRecordingFinished = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({ allowsBackgroundRecording: true, onRecordingFinished }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  const status = {
    ...finishedStatus(mockRecorder.uri),
    hasError: true,
    error: 'Audio server error',
  };
  await act(async () => {
    mockRecordingStatus?.(status);
    mockRecordingStatus?.(status);
  });
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  expect(onRecordingFinished).not.toHaveBeenCalled();
  await act(async () => {
    drained.resolve();
  });
  expect(onRecordingFinished).toHaveBeenCalledTimes(1);
  expect(onRecordingFinished).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Audio server error' }),
  );
});

test.each(['raw-stop', 'cancel'] as const)(
  '%s cannot consume or delete interrupted audio before native drain',
  async (operation) => {
    const drained = deferredVoid();
    mockRecorder.stop.mockReturnValueOnce(drained.promise);
    const onRecordingFinished = jest.fn();
    const { result } = renderHook(() =>
      useAudioRecording({ allowsBackgroundRecording: true, onRecordingFinished }),
    );
    await act(async () => {
      await result.current.startRecording();
    });
    const uri = mockRecorder.uri;
    await act(async () => {
      mockRecordingStatus?.({ ...finishedStatus(uri), hasError: true, error: 'Interrupted' });
    });
    let settled = false;
    let returned: string | null | undefined;
    let consuming!: Promise<void>;
    await act(async () => {
      consuming = (async () => {
        if (operation === 'raw-stop') returned = await result.current.stopRecordingRaw();
        else await result.current.cancelRecording();
        settled = true;
      })();
    });
    expect(settled).toBe(false);
    expect(returned).toBeUndefined();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(onRecordingFinished).not.toHaveBeenCalled();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      mockRecorder.isRecording = false;
      drained.resolve();
      await consuming;
    });
    expect(settled).toBe(true);
    if (operation === 'raw-stop') {
      expect(returned).toBe(uri);
      expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    } else {
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
      expect(onRecordingFinished).not.toHaveBeenCalled();
    }
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  },
);

test('a new start waits for interrupted native drain and explicit consumption of its audio', async () => {
  const drained = deferredVoid();
  mockRecorder.stop.mockReturnValueOnce(drained.promise);
  const onRecordingFinished = jest.fn();
  const { result } = renderHook(() =>
    useAudioRecording({ allowsBackgroundRecording: true, onRecordingFinished }),
  );
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    mockRecordingStatus?.({
      ...finishedStatus(mockRecorder.uri),
      hasError: true,
      error: 'Interrupted',
    });
    await result.current.startRecording();
  });
  expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
  expect(mockRecorder.record).toHaveBeenCalledTimes(1);
  await act(async () => {
    mockRecorder.isRecording = false;
    drained.resolve();
  });
  await act(async () => {
    await result.current.startRecording();
  });
  expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.stopRecordingRaw();
  });
  mockRecorder.uri = 'file:///cache/new-after-drain.m4a';
  await act(async () => {
    await result.current.startRecording();
  });
  expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(2);
  expect(mockRecorder.record).toHaveBeenCalledTimes(2);
});

test('external completion handling stays opt-in for existing dictation consumers', async () => {
  const { result } = renderHook(() => useAudioRecording());
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    mockRecordingStatus?.({
      ...finishedStatus(mockRecorder.uri),
      hasError: true,
      error: 'Ignored by existing flow',
    });
  });
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  expect(result.current.isRecording).toBe(true);
});

test('background batch notification Stop finalizes and saves the exact retained audio once without a callback', async () => {
  jest.mocked(transcribeAndCleanup).mockResolvedValue({
    text: 'Final complete speech',
    originalText: 'Final complete speech',
    cleanupApplied: false,
    fusedCleanup: false,
    transcription: { text: 'Final complete speech', provider: 'local', duration: 2 },
  });
  const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  mockRecorder.isRecording = false;
  await act(async () => {
    mockRecordingStatus?.(finishedStatus('file:///cache/notification-final.m4a'));
    mockRecordingStatus?.(finishedStatus('file:///cache/notification-final.m4a'));
  });
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  expect(retainTranscriptAudio).toHaveBeenCalledWith(
    'file:///cache/notification-final.m4a',
    expect.any(Object),
  );
  expect(transcribeAndCleanup).toHaveBeenCalledTimes(1);
  expect(transcribeAndCleanup).toHaveBeenCalledWith(
    expect.objectContaining({ audioUri: 'file:///cache/transcript-audio/retained.m4a' }),
    expect.any(Object),
  );
  expect(mockAddTranscript).toHaveBeenCalledTimes(1);
  expect(mockAddTranscript).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Final complete speech' }),
  );
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
});

test('background batch native error drains and saves retryable audio without persisting successful partial text', async () => {
  const drained = deferredVoid();
  mockRecorder.stop.mockReturnValueOnce(drained.promise);
  const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    mockRecordingStatus?.({
      ...finishedStatus(mockRecorder.uri),
      hasError: true,
      error: 'Native microphone interrupted',
    });
  });
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  expect(retainTranscriptAudio).not.toHaveBeenCalled();
  await act(async () => {
    mockRecorder.isRecording = false;
    drained.resolve();
  });
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  expect(mockAddFailedTranscript).toHaveBeenCalledTimes(1);
  expect(mockAddFailedTranscript).toHaveBeenCalledWith(
    expect.objectContaining({
      audioUrl: 'file:///cache/transcript-audio/retained.m4a',
      errorMessage: 'Native microphone interrupted',
    }),
  );
  expect(transcribeAndCleanup).not.toHaveBeenCalled();
  expect(mockAddTranscript).not.toHaveBeenCalled();
});

test('local automatic notification Stop retains audio while hidden and transcribes only after foreground', async () => {
  jest.mocked(transcribeAndCleanup).mockResolvedValue({
    text: 'Complete resumed speech',
    originalText: 'Complete resumed speech',
    cleanupApplied: false,
    fusedCleanup: false,
    transcription: { text: 'Complete resumed speech', provider: 'local', duration: 3 },
  });
  const { result } = renderHook(() => useAudioRecording({ allowsBackgroundRecording: true }));
  await act(async () => {
    await result.current.startRecording();
  });
  await act(async () => {
    appStateChanged('background');
    mockRecorder.isRecording = false;
    mockRecordingStatus?.(finishedStatus(mockRecorder.uri));
  });
  expect(retainTranscriptAudio).toHaveBeenCalledTimes(1);
  expect(transcribeAndCleanup).not.toHaveBeenCalled();
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
  expect(deleteManagedTranscriptAudio).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  expect(result.current.isProcessing).toBe(true);
  await act(async () => {
    appStateChanged('active');
  });
  expect(transcribeAndCleanup).toHaveBeenCalledTimes(1);
  expect(mockAddTranscript).toHaveBeenCalledTimes(1);
  expect(mockAddFailedTranscript).not.toHaveBeenCalled();
});

test('shouldCancel abandons background finalization and deletes retained audio without starting ASR', async () => {
  jest.useFakeTimers();
  try {
    const clearPoll = jest.spyOn(global, 'clearInterval');
    let cancelled = false;
    const { result } = renderHook(() =>
      useAudioRecording({ allowsBackgroundRecording: true, shouldCancel: () => cancelled }),
    );
    await act(async () => {
      await result.current.startRecording();
    });
    await act(async () => {
      appStateChanged('background');
      mockRecorder.isRecording = false;
      mockRecordingStatus?.(finishedStatus(mockRecorder.uri));
    });
    expect(retainTranscriptAudio).toHaveBeenCalledTimes(1);
    expect(deleteManagedTranscriptAudio).not.toHaveBeenCalled();
    cancelled = true;
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(deleteManagedTranscriptAudio).toHaveBeenCalledWith(
      'file:///cache/transcript-audio/retained.m4a',
    );
    expect(transcribeAndCleanup).not.toHaveBeenCalled();
    expect(mockAddTranscript).not.toHaveBeenCalled();
    expect(mockAddFailedTranscript).not.toHaveBeenCalled();
    expect(result.current.isProcessing).toBe(false);
    await act(async () => {
      appStateChanged('active');
    });
    expect(transcribeAndCleanup).not.toHaveBeenCalled();
    expect(clearPoll).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
