import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type AndroidSpeechMode = 'basic' | 'advanced';
export type AndroidSpeechStatus = {
  status: 'available' | 'downloadable' | 'downloading' | 'unavailable';
  reason?: string;
};

export type AndroidLiveSpeechEvent =
  | { type: 'transcript'; sessionId: string; text: string; isFinal: boolean }
  | { type: 'level'; sessionId: string; level: number }
  | { type: 'error'; sessionId: string; message: string; code: string };

export interface AndroidLiveSpeechResult {
  text: string;
  fileUri: string;
  durationMs: number;
  error?: { code: string; message: string };
}

export type AndroidCaptureAudioEvent =
  | {
      type: 'audio';
      sessionId: string;
      pcmBase64: string;
      sequence?: number;
      frameOffset?: number;
    }
  | { type: 'level'; sessionId: string; level: number }
  | { type: 'error'; sessionId: string; code: string; message: string };

export interface AndroidCaptureAudioResult {
  fileUri: string;
  durationMs: number;
  error?: { code: string; message: string };
}

type LiveSubscription = { remove(): void };

interface NativeAndroidSpeech {
  startCapture?(sessionId: string): Promise<void>;
  stopCapture?(sessionId: string): Promise<AndroidCaptureAudioResult>;
  cancelCapture?(sessionId: string): Promise<void>;
  startLive?(sessionId: string, mode: AndroidSpeechMode, locale: string): Promise<void>;
  stopLive?(sessionId: string): Promise<AndroidLiveSpeechResult>;
  cancelLive?(sessionId: string): Promise<void>;
  addListener?: {
    (eventName: 'live-speech', listener: (event: AndroidLiveSpeechEvent) => void): LiveSubscription;
    (
      eventName: 'capture-audio',
      listener: (event: AndroidCaptureAudioEvent) => void,
    ): LiveSubscription;
  };
  convertToWav(audioUri: string): Promise<string>;
  getStatus(mode: AndroidSpeechMode, locale: string): Promise<AndroidSpeechStatus>;
  download(mode: AndroidSpeechMode, locale: string): Promise<void>;
  transcribe(audioUri: string, mode: AndroidSpeechMode, locale: string): Promise<{ text: string }>;
  cancel(): Promise<void>;
  isBatteryOptimizationExempt(): Promise<boolean>;
  openBatteryOptimizationSettings(): Promise<void>;
}

const nativeModule =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<NativeAndroidSpeech>('AndroidSpeech')
    : null;

function requireModule(): NativeAndroidSpeech {
  if (!nativeModule) {
    throw new Error('Android speech requires an Android development or production build.');
  }
  return nativeModule;
}

async function withCancellation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_ANDROID_SPEECH_CANCELLED'
    ) {
      error.name = 'AbortError';
    }
    throw error;
  }
}

export const AndroidSpeech = {
  isAvailable(): boolean {
    return nativeModule !== null;
  },

  isLiveAvailable(): boolean {
    return (
      nativeModule !== null &&
      typeof nativeModule.startLive === 'function' &&
      typeof nativeModule.stopLive === 'function' &&
      typeof nativeModule.cancelLive === 'function' &&
      typeof nativeModule.addListener === 'function'
    );
  },

  isCaptureAvailable(): boolean {
    return (
      nativeModule !== null &&
      typeof nativeModule.startCapture === 'function' &&
      typeof nativeModule.stopCapture === 'function' &&
      typeof nativeModule.cancelCapture === 'function' &&
      typeof nativeModule.addListener === 'function'
    );
  },

  async startCapture(sessionId: string): Promise<void> {
    const start = requireModule().startCapture;
    if (!start) throw new Error('Live Whisper requires an updated Android native build.');
    await withCancellation(() => start.call(nativeModule, sessionId));
  },

  async stopCapture(sessionId: string): Promise<AndroidCaptureAudioResult> {
    const stop = requireModule().stopCapture;
    if (!stop) throw new Error('Live Whisper requires an updated Android native build.');
    return withCancellation(() => stop.call(nativeModule, sessionId));
  },

  async cancelCapture(sessionId: string): Promise<void> {
    await nativeModule?.cancelCapture?.(sessionId);
  },

  addCaptureListener(listener: (event: AndroidCaptureAudioEvent) => void): LiveSubscription {
    return nativeModule?.addListener?.('capture-audio', listener) ?? { remove() {} };
  },

  async startLive(sessionId: string, mode: AndroidSpeechMode, locale: string): Promise<void> {
    const start = requireModule().startLive;
    if (!start) throw new Error('Live speech requires an updated Android native build.');
    await withCancellation(() => start.call(nativeModule, sessionId, mode, locale));
  },

  async stopLive(sessionId: string): Promise<AndroidLiveSpeechResult> {
    const stop = requireModule().stopLive;
    if (!stop) throw new Error('Live speech requires an updated Android native build.');
    return withCancellation(() => stop.call(nativeModule, sessionId));
  },

  async cancelLive(sessionId: string): Promise<void> {
    await nativeModule?.cancelLive?.(sessionId);
  },

  addLiveListener(listener: (event: AndroidLiveSpeechEvent) => void): LiveSubscription {
    return nativeModule?.addListener?.('live-speech', listener) ?? { remove() {} };
  },

  /** Returns a new cache file owned by the caller, which must delete it after inference. */
  async convertToWav(audioUri: string): Promise<string> {
    return withCancellation(() => requireModule().convertToWav(audioUri));
  },

  async getStatus(mode: AndroidSpeechMode, locale: string): Promise<AndroidSpeechStatus> {
    if (!nativeModule) {
      return {
        status: 'unavailable',
        reason: 'Android speech is not linked in this build.',
      };
    }
    return nativeModule.getStatus(mode, locale);
  },

  async download(mode: AndroidSpeechMode, locale: string): Promise<void> {
    return withCancellation(() => requireModule().download(mode, locale));
  },

  async transcribe(
    audioUri: string,
    mode: AndroidSpeechMode,
    locale: string,
  ): Promise<{ text: string }> {
    return withCancellation(() => requireModule().transcribe(audioUri, mode, locale));
  },

  async cancel(): Promise<void> {
    await nativeModule?.cancel();
  },

  async isBatteryOptimizationExempt(): Promise<boolean> {
    return requireModule().isBatteryOptimizationExempt();
  },

  async openBatteryOptimizationSettings(): Promise<void> {
    return requireModule().openBatteryOptimizationSettings();
  },
};
