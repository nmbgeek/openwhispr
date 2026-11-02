import { AppState } from 'react-native';
import {
  AndroidSpeech,
  type AndroidLiveSpeechEvent,
  type AndroidLiveSpeechResult,
} from '../../../modules/android-speech/src';
import { mlKitMode, type MlKitModelKey } from '../../lib/localSpeechModels';
import type { WhisperLivePreview } from './WhisperLivePreview';

export type AndroidLiveModel = MlKitModelKey | 'whisper-base';
export interface AndroidLiveRecorder {
  addListener(listener: (event: AndroidLiveSpeechEvent) => void): { remove(): void };
  start(): Promise<void>;
  stop(): Promise<AndroidLiveSpeechResult>;
  cancel(): Promise<void>;
}

function waitForForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Recording was cancelled.'));
  if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive')
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      subscription.remove();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error('Recording was cancelled.'));
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        cleanup();
        resolve();
      }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function createAndroidLiveRecorder(
  sessionId: string,
  model: AndroidLiveModel,
  language: string,
  allowsBackgroundRecording = false,
): AndroidLiveRecorder {
  if (model !== 'whisper-base') {
    const abort = new AbortController();
    let finalizing = false;
    return {
      addListener: (listener) => AndroidSpeech.addLiveListener(listener),
      start: () =>
        allowsBackgroundRecording
          ? AndroidSpeech.startLive(sessionId, mlKitMode(model), language, true)
          : AndroidSpeech.startLive(sessionId, mlKitMode(model), language),
      async stop() {
        const result = await AndroidSpeech.stopLive(sessionId);
        if (!result.requiresFinalTranscription || result.error) return result;
        try {
          await waitForForeground(abort.signal);
          finalizing = true;
          const final = await AndroidSpeech.transcribe(result.fileUri, mlKitMode(model), language);
          if (abort.signal.aborted) throw new Error('Recording was cancelled.');
          return { ...result, text: final.text };
        } catch (error: unknown) {
          return {
            ...result,
            text: '',
            error: {
              code: 'MLKIT_TRANSCRIPTION',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        } finally {
          finalizing = false;
        }
      },
      async cancel() {
        abort.abort();
        await AndroidSpeech.cancelLive(sessionId);
        if (finalizing) await AndroidSpeech.cancel();
      },
    };
  }
  const { WhisperLivePreview } =
    require('./WhisperLivePreview') as typeof import('./WhisperLivePreview');
  let cancelled = false;
  const abort = new AbortController();
  let appStateSubscription: { remove(): void } | null = null;
  let preview: WhisperLivePreview | null = null;
  let preparing: Promise<void> | null = null;
  let listener: ((event: AndroidLiveSpeechEvent) => void) | null = null;
  let subscription: { remove(): void } | null = null;
  const detach = () => {
    subscription?.remove();
    subscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
  };
  return {
    addListener(callback) {
      listener = callback;
      return {
        remove: () => {
          listener = null;
        },
      };
    },
    start() {
      preparing = (async () => {
        // Snapshot the same personal/shared/snippet hints batch Whisper uses,
        // before model preparation or native capture can yield to later edits.
        const { buildLocalWhisperPrompt } =
          require('../../lib/localWhisperPrompt') as typeof import('../../lib/localWhisperPrompt');
        const prompt = buildLocalWhisperPrompt('recording');
        preview = await WhisperLivePreview.prepare(
          { language, prompt },
          {
            onText: (text) => listener?.({ type: 'transcript', sessionId, text, isFinal: false }),
            // A draft failure leaves the recording intact; the full pass can still succeed.
            onError: (error) => console.warn('[audio] Whisper preview:', error.message),
          },
        );
        if (cancelled) {
          await preview.cancel();
          return;
        }
        if (allowsBackgroundRecording) {
          appStateSubscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') preview?.resume();
            else preview?.pause();
          });
        }
        subscription = AndroidSpeech.addCaptureListener((event) => {
          if (event.sessionId !== sessionId || cancelled) return;
          if (event.type === 'audio') preview?.pushPcm(event.pcmBase64);
          else if (event.type === 'preview-reset') {
            preview?.resume();
            listener?.({ type: 'transcript', sessionId, text: '', isFinal: false });
          } else listener?.(event);
        });
        try {
          if (allowsBackgroundRecording) await AndroidSpeech.startCapture(sessionId, true);
          else await AndroidSpeech.startCapture(sessionId);
          if (cancelled) await AndroidSpeech.cancelCapture(sessionId);
        } catch (error) {
          detach();
          await preview.cancel();
          throw error;
        }
      })();
      return preparing;
    },
    async stop() {
      const result = await AndroidSpeech.stopCapture(sessionId).finally(detach);
      try {
        if (result.error) {
          await preview?.cancel();
          return { ...result, text: '' };
        }
        if (!preview) throw new Error('Whisper preview was not initialized.');
        await waitForForeground(abort.signal);
        const final = await preview.finish(result.fileUri);
        return { ...result, text: final.text };
      } catch (error: unknown) {
        return {
          ...result,
          text: '',
          error: {
            code: 'WHISPER_TRANSCRIPTION',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    async cancel() {
      cancelled = true;
      abort.abort();
      detach();
      try {
        await AndroidSpeech.cancelCapture(sessionId);
      } finally {
        await preparing?.catch(() => undefined);
        await preview?.cancel();
      }
    },
  };
}
