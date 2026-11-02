jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('whisper.rn', () => ({ initWhisper: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 100 })),
  readDirectoryAsync: jest.fn(async () => ['base.bin']),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('../../../../modules/android-speech/src', () => ({
  AndroidSpeech: { convertToWav: jest.fn(async () => 'file:///converted.wav') },
}));

import { initWhisper } from 'whisper.rn';
import { AndroidSpeech } from '../../../../modules/android-speech/src';
import { LocalWhisperService } from '../LocalWhisperService';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const nativeResult = (isAborted = false) => ({
  result: ' Speech ',
  language: 'en',
  segments: [],
  isAborted,
});
const mockData = jest.fn();
const mockFile = jest.fn();
const mockRelease = jest.fn(async () => undefined);
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

beforeEach(async () => {
  await LocalWhisperService.cleanup();
  jest.clearAllMocks();
  mockData.mockReset().mockReturnValue({
    promise: Promise.resolve(nativeResult()),
    stop: jest.fn(async () => undefined),
  });
  mockFile.mockReset().mockReturnValue({
    promise: Promise.resolve(nativeResult()),
    stop: jest.fn(async () => undefined),
  });
  jest.mocked(initWhisper).mockResolvedValue({
    transcribeData: mockData,
    transcribe: mockFile,
    release: mockRelease,
  } as unknown as Awaited<ReturnType<typeof initWhisper>>);
});

test('sends raw PCM16 ArrayBuffer to native with explicit auto-detect and captured dictionary hints', async () => {
  const pcm = new Uint8Array([0, 0, 255, 127, 0, 128]).buffer;
  await expect(LocalWhisperService.transcribePcm(pcm, { prompt: 'OpenWhispr' })).resolves.toBe(
    'Speech',
  );
  expect(mockData).toHaveBeenCalledWith(
    pcm,
    expect.objectContaining({ language: 'auto', prompt: 'OpenWhispr', translate: false }),
  );
  expect(AndroidSpeech.convertToWav).not.toHaveBeenCalled();
});

test('a late preview abort cannot reach the next file job: both native promises drain under the lock', async () => {
  const decode = deferred<ReturnType<typeof nativeResult>>();
  const aborted = deferred<void>();
  const stop = jest.fn(() => aborted.promise);
  mockData.mockReturnValueOnce({ promise: decode.promise, stop });
  const controller = new AbortController();
  const preview = LocalWhisperService.transcribePcm(new ArrayBuffer(32000), {
    signal: controller.signal,
  });
  const previewRejected = preview.catch((error: unknown) => error);
  await flush();
  expect(mockData).toHaveBeenCalledTimes(1);
  controller.abort();
  const final = LocalWhisperService.transcribe('file:///native.wav', {
    modelName: 'base',
    language: 'auto',
    pcm16Wav: true,
  });
  decode.resolve(nativeResult(true));
  await flush();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mockFile).not.toHaveBeenCalled();
  aborted.resolve();
  expect(await previewRejected).toMatchObject({ name: 'AbortError' });
  await final;
  expect(mockFile).toHaveBeenCalledTimes(1);
  expect(AndroidSpeech.convertToWav).not.toHaveBeenCalled();
});

test('canceling final file inference stops its task before cleanup can release the context', async () => {
  const decode = deferred<ReturnType<typeof nativeResult>>();
  const aborted = deferred<void>();
  const stop = jest.fn(() => aborted.promise);
  mockFile.mockReturnValueOnce({ promise: decode.promise, stop });
  const controller = new AbortController();
  const transcription = LocalWhisperService.transcribe('file:///native.wav', {
    signal: controller.signal,
    pcm16Wav: true,
  });
  const rejected = transcription.catch((error: unknown) => error);
  await flush();
  controller.abort();
  const cleanup = LocalWhisperService.cleanup();
  decode.resolve(nativeResult(true));
  await flush();
  expect(mockRelease).not.toHaveBeenCalled();
  aborted.resolve();
  expect(await rejected).toMatchObject({ name: 'AbortError' });
  await cleanup;
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('already aborted or malformed previews never start native inference', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    LocalWhisperService.transcribePcm(new ArrayBuffer(4), { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await expect(LocalWhisperService.transcribePcm(new ArrayBuffer(3))).rejects.toThrow(
    'complete PCM16 samples',
  );
  expect(mockData).not.toHaveBeenCalled();
});
