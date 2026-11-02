jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: jest.fn() },
}));
jest.mock('@/lib/localWhisperPrompt', () => ({
  buildLocalWhisperPrompt: jest.fn(() => 'Captured dictionary'),
}));
jest.mock('../../../../modules/android-speech/src', () => ({
  AndroidSpeech: {
    transcribe: jest.fn(),
    cancel: jest.fn(),
    addLiveListener: jest.fn(),
    startLive: jest.fn(),
    stopLive: jest.fn(),
    cancelLive: jest.fn(),
    addCaptureListener: jest.fn(),
    startCapture: jest.fn(),
    stopCapture: jest.fn(),
    cancelCapture: jest.fn(),
  },
}));
jest.mock('../WhisperLivePreview', () => ({ WhisperLivePreview: { prepare: jest.fn() } }));

import {
  AndroidSpeech,
  type AndroidCaptureAudioEvent,
} from '../../../../modules/android-speech/src';
import { AppState, type AppStateStatus } from 'react-native';
import { WhisperLivePreview } from '../WhisperLivePreview';
import { createAndroidLiveRecorder } from '../AndroidLiveTranscription';
import { buildLocalWhisperPrompt } from '@/lib/localWhisperPrompt';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const remove = jest.fn();
const preview = {
  pushPcm: jest.fn(),
  finish: jest.fn(),
  cancel: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
};
const wav = { fileUri: 'file:///cache/transcript-audio/capture.wav', durationMs: 2400 };
let captureEvent: (event: AndroidCaptureAudioEvent) => void;

const appListeners = new Set<(state: AppStateStatus) => void>();
function appState(state: AppStateStatus) {
  AppState.currentState = state;
  for (const callback of [...appListeners]) callback(state);
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.resetAllMocks();
  appListeners.clear();
  AppState.currentState = 'active';
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    appListeners.add(callback);
    return { remove: () => appListeners.delete(callback) };
  });
  jest.mocked(AndroidSpeech.transcribe).mockResolvedValue({ text: 'Complete ML Kit recording' });
  jest.mocked(buildLocalWhisperPrompt).mockReturnValue('Captured dictionary');
  jest
    .mocked(WhisperLivePreview.prepare)
    .mockResolvedValue(preview as unknown as WhisperLivePreview);
  jest.mocked(AndroidSpeech.addCaptureListener).mockImplementation((callback) => {
    captureEvent = callback;
    return { remove };
  });
  jest.mocked(AndroidSpeech.startCapture).mockResolvedValue(undefined);
  jest.mocked(AndroidSpeech.cancelCapture).mockResolvedValue(undefined);
  jest.mocked(AndroidSpeech.stopCapture).mockResolvedValue(wav);
  preview.finish.mockResolvedValue({ text: 'Complete final recording', provider: 'local' });
  preview.cancel.mockResolvedValue(undefined);
});

test('Whisper snapshots the shared dictionary prompt before asynchronous model preparation', async () => {
  const preparation = deferred<WhisperLivePreview>();
  jest.mocked(WhisperLivePreview.prepare).mockReturnValueOnce(preparation.promise);
  const recorder = createAndroidLiveRecorder('prompt-snapshot', 'whisper-base', 'auto');
  const starting = recorder.start();
  expect(buildLocalWhisperPrompt).toHaveBeenCalledWith('recording');
  jest.mocked(buildLocalWhisperPrompt).mockReturnValue('Changed later');
  expect(WhisperLivePreview.prepare).toHaveBeenCalledWith(
    { language: 'auto', prompt: 'Captured dictionary' },
    expect.any(Object),
  );
  preparation.resolve(preview as unknown as WhisperLivePreview);
  await starting;
  await recorder.stop();
  expect(buildLocalWhisperPrompt).toHaveBeenCalledTimes(1);
});

test('Whisper captures PCM without any ML Kit calls, filters stale events, and saves the full-file final', async () => {
  const listener = jest.fn();
  const recorder = createAndroidLiveRecorder('current', 'whisper-base', 'fr');
  recorder.addListener(listener);
  await recorder.start();
  expect(WhisperLivePreview.prepare).toHaveBeenCalledWith(
    { language: 'fr', prompt: 'Captured dictionary' },
    expect.any(Object),
  );
  captureEvent({ type: 'audio', sessionId: 'old', pcmBase64: 'AAAA' });
  expect(preview.pushPcm).not.toHaveBeenCalled();
  captureEvent({ type: 'audio', sessionId: 'current', pcmBase64: 'AAAA' });
  expect(preview.pushPcm).toHaveBeenCalledWith('AAAA');
  captureEvent({ type: 'level', sessionId: 'current', level: 0.4 });
  expect(listener).toHaveBeenCalledWith({ type: 'level', sessionId: 'current', level: 0.4 });
  await expect(recorder.stop()).resolves.toEqual({ ...wav, text: 'Complete final recording' });
  expect(preview.finish).toHaveBeenCalledWith(wav.fileUri);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(AndroidSpeech.startLive).not.toHaveBeenCalled();
  expect(AndroidSpeech.stopLive).not.toHaveBeenCalled();
  expect(AndroidSpeech.cancelLive).not.toHaveBeenCalled();
  expect(AndroidSpeech.addLiveListener).not.toHaveBeenCalled();
});

test('cancel during model preparation cannot later open the microphone', async () => {
  const preparation = deferred<WhisperLivePreview>();
  jest.mocked(WhisperLivePreview.prepare).mockReturnValue(preparation.promise);
  const recorder = createAndroidLiveRecorder('cancelled', 'whisper-base', 'en');
  const starting = recorder.start();
  const cancelling = recorder.cancel();
  preparation.resolve(preview as unknown as WhisperLivePreview);
  await Promise.all([starting, cancelling]);
  expect(AndroidSpeech.startCapture).not.toHaveBeenCalled();
  expect(AndroidSpeech.addCaptureListener).not.toHaveBeenCalled();
  expect(preview.cancel).toHaveBeenCalled();
});

test('cancel while native start is pending cancels again after start settles', async () => {
  const startingNative = deferred<void>();
  jest.mocked(AndroidSpeech.startCapture).mockReturnValue(startingNative.promise);
  const recorder = createAndroidLiveRecorder('pending', 'whisper-base', 'en');
  const starting = recorder.start();
  await Promise.resolve();
  expect(AndroidSpeech.startCapture).toHaveBeenCalled();
  const cancelling = recorder.cancel();
  startingNative.resolve(undefined);
  await Promise.all([starting, cancelling]);
  expect(AndroidSpeech.cancelCapture).toHaveBeenCalledWith('pending');
  expect(remove).toHaveBeenCalled();
  expect(preview.cancel).toHaveBeenCalled();
});

test('full-file inference failure returns retryable retained audio without draft text', async () => {
  preview.finish.mockRejectedValue(new Error('Inference failed'));
  const recorder = createAndroidLiveRecorder('failed', 'whisper-base', 'en');
  await recorder.start();
  await expect(recorder.stop()).resolves.toEqual({
    ...wav,
    text: '',
    error: { code: 'WHISPER_TRANSCRIPTION', message: 'Inference failed' },
  });
});

test('native audio errors preserve WAV and bypass final inference', async () => {
  const error = { code: 'MICROPHONE_READ', message: 'Interrupted' };
  jest.mocked(AndroidSpeech.stopCapture).mockResolvedValue({ ...wav, error });
  const recorder = createAndroidLiveRecorder('failed', 'whisper-base', 'en');
  await recorder.start();
  await expect(recorder.stop()).resolves.toEqual({ ...wav, error, text: '' });
  expect(preview.finish).not.toHaveBeenCalled();
  expect(preview.cancel).toHaveBeenCalled();
});

test('native start failure detaches the capture subscription', async () => {
  jest.mocked(AndroidSpeech.startCapture).mockRejectedValue(new Error('No microphone'));
  const recorder = createAndroidLiveRecorder('failed', 'whisper-base', 'en');
  await expect(recorder.start()).rejects.toThrow('No microphone');
  expect(remove).toHaveBeenCalled();
});

test('native stop failure detaches the capture subscription', async () => {
  jest.mocked(AndroidSpeech.stopCapture).mockRejectedValue(new Error('Stop failed'));
  const recorder = createAndroidLiveRecorder('failed', 'whisper-base', 'en');
  await recorder.start();
  await expect(recorder.stop()).rejects.toThrow('Stop failed');
  expect(remove).toHaveBeenCalled();
});

test('native cancellation failure still cancels preview inference', async () => {
  jest.mocked(AndroidSpeech.cancelCapture).mockRejectedValue(new Error('Bridge unavailable'));
  const recorder = createAndroidLiveRecorder('failed', 'whisper-base', 'en');
  await recorder.start();
  await expect(recorder.cancel()).rejects.toThrow('Bridge unavailable');
  expect(remove).toHaveBeenCalled();
  expect(preview.cancel).toHaveBeenCalled();
});

test.each(['mlkit-basic', 'mlkit-advanced'] as const)(
  '%s keeps the ML Kit live backend',
  async (model) => {
    const recorder = createAndroidLiveRecorder('mlkit', model, 'en-US');
    await recorder.start();
    expect(AndroidSpeech.startLive).toHaveBeenCalledWith(
      'mlkit',
      model === 'mlkit-basic' ? 'basic' : 'advanced',
      'en-US',
    );
    expect(WhisperLivePreview.prepare).not.toHaveBeenCalled();
    expect(AndroidSpeech.startCapture).not.toHaveBeenCalled();
  },
);

test.each(['mlkit-basic', 'mlkit-advanced'] as const)(
  '%s resumes background recordings with an authoritative full WAV pass in the captured locale',
  async (model) => {
    const result = { ...wav, text: 'Partial before background', requiresFinalTranscription: true };
    jest.mocked(AndroidSpeech.stopLive).mockResolvedValue(result);
    const recorder = createAndroidLiveRecorder('background', model, 'fr-FR', true);
    await recorder.start();
    expect(AndroidSpeech.startLive).toHaveBeenCalledWith(
      'background',
      model === 'mlkit-basic' ? 'basic' : 'advanced',
      'fr-FR',
      true,
    );
    appState('background');
    let settled = false;
    const stopped = recorder.stop().then((value) => {
      settled = true;
      return value;
    });
    await flush();
    expect(settled).toBe(false);
    expect(AndroidSpeech.transcribe).not.toHaveBeenCalled();
    appState('active');
    await expect(stopped).resolves.toEqual({ ...result, text: 'Complete ML Kit recording' });
    expect(AndroidSpeech.transcribe).toHaveBeenCalledWith(
      wav.fileUri,
      model === 'mlkit-basic' ? 'basic' : 'advanced',
      'fr-FR',
    );
    expect(appListeners.size).toBe(0);
  },
);

test('cancelling ML Kit while waiting for foreground never starts final ASR or returns partial text', async () => {
  jest
    .mocked(AndroidSpeech.stopLive)
    .mockResolvedValue({ ...wav, text: 'Unfinished fragment', requiresFinalTranscription: true });
  const recorder = createAndroidLiveRecorder('cancel-bg', 'mlkit-basic', 'en-US', true);
  await recorder.start();
  appState('background');
  const stopped = recorder.stop();
  await flush();
  await recorder.cancel();
  const result = await stopped;
  expect(result).toMatchObject({
    fileUri: wav.fileUri,
    text: '',
    error: { code: 'MLKIT_TRANSCRIPTION' },
  });
  appState('active');
  await flush();
  expect(AndroidSpeech.transcribe).not.toHaveBeenCalled();
  expect(appListeners.size).toBe(0);
});

test('a previously backgrounded ML Kit result finalizes immediately when the app is already active', async () => {
  jest
    .mocked(AndroidSpeech.stopLive)
    .mockResolvedValue({ ...wav, text: 'Old draft', requiresFinalTranscription: true });
  const recorder = createAndroidLiveRecorder('returned', 'mlkit-advanced', 'es-ES', true);
  await recorder.start();
  await expect(recorder.stop()).resolves.toMatchObject({ text: 'Complete ML Kit recording' });
  expect(AndroidSpeech.transcribe).toHaveBeenCalledWith(wav.fileUri, 'advanced', 'es-ES');
  expect(AppState.addEventListener).not.toHaveBeenCalled();
});

test('ML Kit full-file failure preserves retry audio and clears the earlier partial', async () => {
  jest.mocked(AndroidSpeech.stopLive).mockResolvedValue({
    ...wav,
    text: 'Never persist this partial',
    requiresFinalTranscription: true,
  });
  jest.mocked(AndroidSpeech.transcribe).mockRejectedValue(new Error('Offline model unavailable'));
  const recorder = createAndroidLiveRecorder('failure', 'mlkit-basic', 'en-US', true);
  await recorder.start();
  await expect(recorder.stop()).resolves.toMatchObject({
    fileUri: wav.fileUri,
    text: '',
    error: { code: 'MLKIT_TRANSCRIPTION', message: 'Offline model unavailable' },
  });
});

test('background Whisper forwards native capture protection and pauses/resumes only its preview', async () => {
  const recorder = createAndroidLiveRecorder('whisper-bg', 'whisper-base', 'auto', true);
  await recorder.start();
  expect(AndroidSpeech.startCapture).toHaveBeenCalledWith('whisper-bg', true);
  appState('background');
  expect(preview.pause).toHaveBeenCalledTimes(1);
  expect(AndroidSpeech.cancelCapture).not.toHaveBeenCalled();
  appState('active');
  expect(preview.resume).toHaveBeenCalledTimes(1);
  await recorder.stop();
  expect(appListeners.size).toBe(0);
  appState('background');
  expect(preview.pause).toHaveBeenCalledTimes(1);
});

test('Whisper full-file ASR waits for foreground after native background stop', async () => {
  const recorder = createAndroidLiveRecorder('whisper-wait', 'whisper-base', 'auto', true);
  await recorder.start();
  appState('background');
  const stopped = recorder.stop();
  await flush();
  expect(preview.finish).not.toHaveBeenCalled();
  appState('active');
  await expect(stopped).resolves.toMatchObject({
    fileUri: wav.fileUri,
    text: 'Complete final recording',
  });
  expect(preview.finish).toHaveBeenCalledWith(wav.fileUri);
  expect(appListeners.size).toBe(0);
});
