import { Buffer } from 'buffer';
import { LocalWhisperService } from '../LocalWhisperService';
import { WhisperLivePreview } from '../WhisperLivePreview';

jest.mock('../LocalWhisperService', () => ({
  LocalWhisperService: {
    isAvailable: jest.fn(() => true),
    getAvailableModels: jest.fn(async () => [
      { name: 'base', downloaded: true, path: '/base.bin' },
    ]),
    prepareForLanguage: jest.fn(async () => undefined),
    transcribePcm: jest.fn(async () => 'Recent draft'),
    transcribe: jest.fn(async () => ({
      text: 'Complete recording.',
      provider: 'local',
      duration: 3,
    })),
  },
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const pcmSecond = Buffer.alloc(32000, 7).toString('base64');
const mockPcm = jest.mocked(LocalWhisperService.transcribePcm);
const mockFile = jest.mocked(LocalWhisperService.transcribe);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(10000);
  jest.clearAllMocks();
  mockPcm.mockReset().mockResolvedValue('Recent draft');
  mockFile
    .mockReset()
    .mockResolvedValue({ text: 'Complete recording.', provider: 'local', duration: 3 });
  jest
    .mocked(LocalWhisperService.getAvailableModels)
    .mockResolvedValue([{ name: 'base', downloaded: true, path: '/base.bin', size: 142 }]);
});
afterEach(() => {
  jest.useRealTimers();
});

test('prepares installed multilingual base before capture and refuses missing models', async () => {
  await WhisperLivePreview.prepare({}, { onText: jest.fn() });
  expect(LocalWhisperService.prepareForLanguage).toHaveBeenCalledWith('auto');
  jest.mocked(LocalWhisperService.getAvailableModels).mockResolvedValue([]);
  await expect(WhisperLivePreview.prepare({}, { onText: jest.fn() })).rejects.toThrow(
    'download it first',
  );
});

test('copies exact PCM16 bytes into a dedicated buffer and throttles previews', async () => {
  const onText = jest.fn();
  const session = await WhisperLivePreview.prepare(
    { language: 'es', prompt: 'My dictionary' },
    { onText },
  );
  session.pushPcm(pcmSecond);
  await jest.advanceTimersByTimeAsync(0);
  const buffer = mockPcm.mock.calls[0]?.[0];
  expect(buffer?.byteLength).toBe(32000);
  expect(Buffer.from(buffer ?? new ArrayBuffer(0))).toEqual(Buffer.alloc(32000, 7));
  expect(mockPcm).toHaveBeenCalledWith(
    expect.any(ArrayBuffer),
    expect.objectContaining({ language: 'es', prompt: 'My dictionary' }),
  );
  expect(onText).toHaveBeenCalledWith('Recent draft');
  session.pushPcm(pcmSecond);
  await jest.advanceTimersByTimeAsync(1249);
  expect(mockPcm).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockPcm).toHaveBeenCalledTimes(2);
  await session.cancel();
});

test('slow decoding keeps only one active job and one bounded latest tail, including oversized events', async () => {
  const first = deferred<string>();
  mockPcm.mockReturnValueOnce(first.promise);
  const session = await WhisperLivePreview.prepare({}, { onText: jest.fn() });
  session.pushPcm(pcmSecond);
  await jest.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 100; i++) session.pushPcm(pcmSecond);
  const oversized = Buffer.alloc(16 * 32000);
  for (let i = 0; i < oversized.length; i++) oversized[i] = i % 251;
  session.pushPcm(oversized.toString('base64'));
  await jest.advanceTimersByTimeAsync(5000);
  expect(mockPcm).toHaveBeenCalledTimes(1);
  first.resolve('Old draft');
  await jest.advanceTimersByTimeAsync(0);
  expect(mockPcm).toHaveBeenCalledTimes(2);
  const latest = mockPcm.mock.calls[1]?.[0];
  expect(latest?.byteLength).toBe(8 * 32000);
  expect(Buffer.from(latest ?? new ArrayBuffer(0))).toEqual(
    oversized.subarray(oversized.length - 8 * 32000),
  );
  await session.cancel();
});

test('Stop drains cancelled preview before a single authoritative full-WAV pass', async () => {
  const preview = deferred<string>();
  mockPcm.mockReturnValueOnce(preview.promise);
  const onText = jest.fn();
  const session = await WhisperLivePreview.prepare({}, { onText });
  session.pushPcm(pcmSecond);
  await jest.advanceTimersByTimeAsync(0);
  const result = session.finish('file:///native-owned.wav');
  expect(session.finish('file:///native-owned.wav')).toBe(result);
  expect(mockPcm.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(mockFile).not.toHaveBeenCalled();
  preview.resolve('Late partial');
  await expect(result).resolves.toMatchObject({
    text: 'Complete recording.',
    provider: 'local',
    endpoint: 'whisper-base',
  });
  expect(onText).not.toHaveBeenCalled();
  expect(mockFile).toHaveBeenCalledTimes(1);
  expect(mockFile).toHaveBeenCalledWith(
    'file:///native-owned.wav',
    expect.objectContaining({
      modelName: 'base',
      language: 'auto',
      pcm16Wav: true,
      signal: expect.anything(),
    }),
  );
});

test('cancel drops scheduled/pending drafts and prevents a final pass', async () => {
  const preview = deferred<string>();
  mockPcm.mockReturnValueOnce(preview.promise);
  const onText = jest.fn();
  const session = await WhisperLivePreview.prepare({}, { onText });
  session.pushPcm(pcmSecond);
  await jest.advanceTimersByTimeAsync(0);
  session.pushPcm(pcmSecond);
  const cancelling = session.cancel();
  preview.resolve('Stale result');
  await cancelling;
  await jest.advanceTimersByTimeAsync(10000);
  expect(onText).not.toHaveBeenCalled();
  expect(mockPcm).toHaveBeenCalledTimes(1);
  expect(mockFile).not.toHaveBeenCalled();
  await expect(session.finish('file:///native.wav')).rejects.toMatchObject({ name: 'AbortError' });
});

test('cancel also aborts an in-flight final pass and waits for its termination', async () => {
  mockFile.mockImplementationOnce(
    async (_uri, options) =>
      new Promise((_resolve, reject) => {
        if (typeof options === 'object')
          options.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })),
          );
      }),
  );
  const session = await WhisperLivePreview.prepare({}, { onText: jest.fn() });
  const finished = session.finish('file:///native.wav');
  const rejected = finished.catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(0);
  await session.cancel();
  expect(await rejected).toMatchObject({ name: 'AbortError' });
});

test('preview failure is nonfatal to the retained recording and final transcription', async () => {
  const onError = jest.fn();
  mockPcm.mockRejectedValueOnce(new Error('Preview failed'));
  const session = await WhisperLivePreview.prepare({}, { onText: jest.fn(), onError });
  session.pushPcm(pcmSecond);
  await jest.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Preview failed' }));
  await expect(session.finish('file:///native.wav')).resolves.toMatchObject({
    text: 'Complete recording.',
  });
});
