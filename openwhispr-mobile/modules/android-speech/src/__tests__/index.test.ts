function loadBridge(platform: string, nativeModule: unknown) {
  jest.resetModules();
  const requireOptionalNativeModule = jest.fn(() => nativeModule);
  jest.doMock('expo', () => ({ requireOptionalNativeModule }));
  jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
  const { AndroidSpeech } = require('../index') as typeof import('../index');
  return { AndroidSpeech, requireOptionalNativeModule };
}

describe('AndroidSpeech', () => {
  it('never loads the Android native module on iOS', async () => {
    const { AndroidSpeech, requireOptionalNativeModule } = loadBridge('ios', {});
    expect(AndroidSpeech.isAvailable()).toBe(false);
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
    await expect(AndroidSpeech.getStatus('basic', 'en-US')).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(AndroidSpeech.cancel()).resolves.toBeUndefined();
  });

  it('reports a stale or Expo Go Android build as unavailable', async () => {
    const { AndroidSpeech } = loadBridge('android', null);
    expect(AndroidSpeech.isAvailable()).toBe(false);
    await expect(AndroidSpeech.convertToWav('file:///audio.m4a')).rejects.toThrow(
      'Android development or production build',
    );
    await expect(
      AndroidSpeech.transcribe('file:///audio.m4a', 'advanced', 'en-US'),
    ).rejects.toThrow('Android development or production build');
  });

  it('gates live recording on the complete native API in an older Android binary', async () => {
    const { AndroidSpeech } = loadBridge('android', {
      transcribe: jest.fn(),
      addListener: jest.fn(),
    });
    expect(AndroidSpeech.isAvailable()).toBe(true);
    expect(AndroidSpeech.isLiveAvailable()).toBe(false);
    await expect(AndroidSpeech.startLive('session-1', 'basic', 'en-US')).rejects.toThrow(
      'updated Android native build',
    );
  });

  it('retains a native live failure and its audio instead of converting partial text to success', async () => {
    const result = {
      text: 'A committed fragment',
      fileUri: 'file:///cache/recoverable.wav',
      durationMs: 1_000,
      error: { code: 'DRAIN_TIMEOUT', message: 'Recognition did not finish.' },
    };
    const subscription = { remove: jest.fn() };
    const nativeModule = {
      startLive: jest.fn().mockResolvedValue(undefined),
      stopLive: jest.fn().mockResolvedValue(result),
      cancelLive: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockReturnValue(subscription),
    };
    const { AndroidSpeech } = loadBridge('android', nativeModule);
    expect(AndroidSpeech.isLiveAvailable()).toBe(true);
    const listener = jest.fn();
    expect(AndroidSpeech.addLiveListener(listener)).toBe(subscription);
    await expect(AndroidSpeech.stopLive('session-1')).resolves.toEqual(result);
    expect(nativeModule.cancelLive).not.toHaveBeenCalled();
    expect(nativeModule.addListener).toHaveBeenCalledWith('live-speech', listener);
  });

  it('requires the capture API in addition to older ML Kit live support', async () => {
    const nativeModule = {
      startLive: jest.fn(),
      stopLive: jest.fn(),
      cancelLive: jest.fn(),
      addListener: jest.fn(),
    };
    const { AndroidSpeech } = loadBridge('android', nativeModule);
    expect(AndroidSpeech.isLiveAvailable()).toBe(true);
    expect(AndroidSpeech.isCaptureAvailable()).toBe(false);
    await expect(AndroidSpeech.startCapture('whisper-session')).rejects.toThrow(
      'updated Android native build',
    );
    expect(nativeModule.startLive).not.toHaveBeenCalled();
  });

  it('uses the separate capture namespace and returns owned audio without invoking ML Kit', async () => {
    const result = {
      fileUri: 'file:///cache/transcript-audio/whisper.wav',
      durationMs: 500,
    };
    const subscription = { remove: jest.fn() };
    const nativeModule = {
      startCapture: jest.fn().mockResolvedValue(undefined),
      stopCapture: jest.fn().mockResolvedValue(result),
      cancelCapture: jest.fn().mockResolvedValue(undefined),
      addListener: jest.fn().mockReturnValue(subscription),
      getStatus: jest.fn(),
      download: jest.fn(),
    };
    const { AndroidSpeech } = loadBridge('android', nativeModule);
    expect(AndroidSpeech.isCaptureAvailable()).toBe(true);
    expect(AndroidSpeech.isLiveAvailable()).toBe(false);
    const listener = jest.fn();
    expect(AndroidSpeech.addCaptureListener(listener)).toBe(subscription);
    expect(nativeModule.addListener).toHaveBeenCalledWith('capture-audio', listener);
    await AndroidSpeech.startCapture('whisper-session');
    await expect(AndroidSpeech.stopCapture('whisper-session')).resolves.toEqual(result);
    expect(nativeModule.startCapture).toHaveBeenCalledWith('whisper-session');
    expect(nativeModule.getStatus).not.toHaveBeenCalled();
    expect(nativeModule.download).not.toHaveBeenCalled();
    expect(nativeModule.cancelCapture).not.toHaveBeenCalled();
  });

  it('passes the exact selected mode, locale, and local file to native recognition', async () => {
    const nativeModule = {
      transcribe: jest.fn().mockResolvedValue({ text: 'Recognized locally' }),
      download: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockResolvedValue({ status: 'downloadable' }),
      convertToWav: jest.fn().mockResolvedValue('file:///cache/decoded.wav'),
    };
    const { AndroidSpeech } = loadBridge('android', nativeModule);
    await expect(AndroidSpeech.getStatus('advanced', 'fr-FR')).resolves.toEqual({
      status: 'downloadable',
    });
    expect(nativeModule.download).not.toHaveBeenCalled();
    await AndroidSpeech.download('advanced', 'fr-FR');
    await expect(
      AndroidSpeech.transcribe('file:///audio.m4a', 'advanced', 'fr-FR'),
    ).resolves.toEqual({ text: 'Recognized locally' });
    expect(nativeModule.transcribe).toHaveBeenCalledWith('file:///audio.m4a', 'advanced', 'fr-FR');
    await expect(AndroidSpeech.convertToWav('file:///audio.m4a')).resolves.toBe(
      'file:///cache/decoded.wav',
    );
  });

  it('returns a cancelled recognition as an AbortError without switching engines', async () => {
    const error = Object.assign(new Error('On-device speech was cancelled.'), {
      code: 'ERR_ANDROID_SPEECH_CANCELLED',
    });
    const nativeModule = { transcribe: jest.fn().mockRejectedValue(error) };
    const { AndroidSpeech } = loadBridge('android', nativeModule);
    await expect(
      AndroidSpeech.transcribe('file:///audio.wav', 'basic', 'en-US'),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(nativeModule.transcribe).toHaveBeenCalledTimes(1);
  });
});
