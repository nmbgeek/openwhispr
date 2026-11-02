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

export function createAndroidLiveRecorder(
  sessionId: string,
  model: AndroidLiveModel,
  language: string,
): AndroidLiveRecorder {
  if (model !== 'whisper-base') {
    return {
      addListener: (listener) => AndroidSpeech.addLiveListener(listener),
      start: () => AndroidSpeech.startLive(sessionId, mlKitMode(model), language),
      stop: () => AndroidSpeech.stopLive(sessionId),
      cancel: () => AndroidSpeech.cancelLive(sessionId),
    };
  }
  const { WhisperLivePreview } =
    require('./WhisperLivePreview') as typeof import('./WhisperLivePreview');
  let cancelled = false;
  let preview: WhisperLivePreview | null = null;
  let preparing: Promise<void> | null = null;
  let listener: ((event: AndroidLiveSpeechEvent) => void) | null = null;
  let subscription: { remove(): void } | null = null;
  const detach = () => {
    subscription?.remove();
    subscription = null;
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
        subscription = AndroidSpeech.addCaptureListener((event) => {
          if (event.sessionId !== sessionId || cancelled) return;
          if (event.type === 'audio') preview?.pushPcm(event.pcmBase64);
          else listener?.(event);
        });
        try {
          await AndroidSpeech.startCapture(sessionId);
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
