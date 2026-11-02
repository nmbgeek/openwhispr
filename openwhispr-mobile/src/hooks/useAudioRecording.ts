import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createTranscriptId, useTranscriptStore } from '../store/useTranscriptStore';
import {
  snapshotTextInference,
  snapshotTranscriptionJob,
  type TranscriptionJobRoute,
} from '../lib/inferenceRouting';
import { completeRecordedTranscription, transcribeAndCleanup } from '../lib/transcribeAndCleanup';
import { isLocalModelMissingError } from '../services/transcription/TranscriptionService';
import { analyzeSpeechActivity, createNoSpeechError } from '../lib/speechActivity';
import {
  isMicPermissionError,
  isNoSpeechError,
  MicPermissionError,
  NO_SPEECH_ERROR_MESSAGE,
} from '../lib/permissions';
import { getPreferredTranscriptionLanguage } from '../lib/transcriptionLanguage';
import { toFriendlyTranscriptionErrorMessage } from '../lib/transcriptionErrors';
import { deleteManagedTranscriptAudio, retainTranscriptAudio } from '../lib/transcriptAudio';
import { isUsageLimitError, type UsageLimitError } from '../lib/usageLimitError';
import { randomUUID } from '../lib/uuid';
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResponse } from '../types';
import { AndroidSpeech } from '../../modules/android-speech/src';
import {
  isMlKitModelKey,
  mlKitLocale,
  mlKitMode,
  type MlKitModelKey,
} from '../lib/localSpeechModels';
import {
  getExpoAudioModule,
  isExpoAudioAvailable,
  getDefaultRecorderOptions,
} from '../utils/expoAudio';
import { useAudioRecorder } from 'expo-audio';

export interface UseAudioRecordingOptions {
  // Only normal dictation opts in; raw audio/meeting/voice-enrollment callers keep Expo capture.
  liveTranscription?: boolean;
  onComplete?: (text: string) => void;
  onError?: (error: Error) => void;
  allowsBackgroundRecording?: boolean;
  // Defaults to true. When false, nothing reaches transcript history (no row on
  // success or failure) and the recording is deleted once its outcome is known.
  saveToHistory?: boolean;
  // Private mode but the on-device model is unavailable. We never fall back to
  // the cloud silently — the caller prompts, and may invoke retryWithCloud to
  // transcribe the recording we already captured. Call discard when the user
  // declines; it deletes the recording only when saveToHistory is false, since
  // otherwise the failed history row keeps it for a later retry.
  onLocalModelMissing?: (retryWithCloud: () => void, discard: () => Promise<void>) => void;
  // Cloud quota is exhausted. The caller can present billing, refresh backend
  // usage, then invoke retryWithCloud only if quota/subscription now permits it.
  onUsageLimitReached?: (
    error: UsageLimitError,
    retryWithCloud: () => Promise<void>,
  ) => void | Promise<void>;
  // Defaults to true. When false the recording gets its raw transcript back: no cleanup pass,
  // fused or separate, and no snippet expansion, so nothing rewrites it or takes it to a cleanup
  // route its transcription never used.
  cleanup?: boolean;
  // Polled from the moment the recording stops. Once it returns true, transcription retries and
  // cleanup stop and the recording is discarded without reaching history, onComplete or onError.
  shouldCancel?: () => boolean;
}

type RetainedRecordingAudio = {
  id: string;
  audioUrl: string;
  audioFileName?: string;
  audioMimeType?: string;
};

type LiveRecordingSession = {
  id: string;
  model: MlKitModelKey;
  locale: string;
  phase: 'starting' | 'recording' | 'stopping';
  cancelled: boolean;
  retainHistory: boolean;
  error: Error | null;
  subscription: { remove: () => void } | null;
};

// Marks cleanup unavailable for a recording without cleanup: the job then skips the fused cloud
// cleanup and the separate pass alike, even with the cleanup route it fills in for itself.
const CLEANUP_OFF = 'Cleanup is off for this recording.';

const fileNameFromUri = (uri: string): string | undefined => uri.split('/').pop() || undefined;

const mimeTypeFromFileName = (fileName?: string): string | undefined => {
  const extension = fileName?.split('.').pop()?.toLowerCase();
  if (extension === 'wav' || extension === 'wave') return 'audio/wav';
  if (extension === 'm4a') return 'audio/m4a';
  if (extension === 'mp3') return 'audio/mpeg';
  return undefined;
};

export function useAudioRecording(options: UseAudioRecordingOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const [isLiveTranscription, setIsLiveTranscription] = useState(false);
  const [liveLevel, setLiveLevel] = useState(0);
  const liveSessionRef = useRef<LiveRecordingSession | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const appActiveRef = useRef(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );
  const abandonedRef = useRef(false);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const cancelRef = useRef<() => Promise<void>>(async () => undefined);

  // Import expo-audio module
  const expoAudio = getExpoAudioModule();
  const addTranscript = useTranscriptStore((state) => state.addTranscript);
  const addFailedTranscript = useTranscriptStore((state) => state.addFailedTranscript);
  const jobRouteRef = useRef<TranscriptionJobRoute>({ provider: 'cloud' });
  // Held only across a native stop: whichever stop or cancel claims it owns the recording, so a
  // second one never stops it again or deletes the file the first is transcribing.
  const stoppingRef = useRef(false);
  // Whether the recording this hook started is still open. A call or Siri pauses the recorder,
  // which then reports not recording, so cancel can't read that from the recorder.
  const openRef = useRef(false);

  const recorderOptions = getDefaultRecorderOptions();
  const audioRecorder = useAudioRecorder(recorderOptions);
  const isSupported = isExpoAudioAvailable() && !!audioRecorder;
  const allowsBackgroundRecording = options.allowsBackgroundRecording === true;
  const saveToHistory = options.saveToHistory !== false;
  const cleanup = options.cleanup !== false;
  const isCancelled = (): boolean => abandonedRef.current || options.shouldCancel?.() === true;

  useEffect(() => {
    mountedRef.current = true;
    const listener = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
      const session = liveSessionRef.current;
      if (
        state !== 'active' &&
        session &&
        (session.phase !== 'stopping' || !session.retainHistory)
      ) {
        void cancelRef.current().catch(() => undefined);
      }
    });
    return () => {
      mountedRef.current = false;
      listener.remove();
      const session = liveSessionRef.current;
      if (session) {
        session.subscription?.remove();
        // Stop commits this recording. Let its final/failed history write finish
        // after navigation; only a capture still in progress is abandoned.
        if (session.phase === 'stopping' && session.retainHistory) return;
        session.cancelled = true;
        abandonedRef.current = true;
        void AndroidSpeech.cancelLive(session.id).catch(() => undefined);
      }
    };
  }, []);

  const ensureAudioSupport = () => {
    if (!isSupported || !expoAudio || !audioRecorder) {
      const error = new Error(
        'Audio recording is unavailable in Expo Go. Build and run a development client (e.g. `expo run:ios`) to test recording features.',
      );
      if (__DEV__) {
        console.warn('[audio] Attempted to use recording without native module support.');
      }
      throw error;
    }
    return { expoAudio, audioRecorder };
  };

  const startRecording = async () => {
    if (startingRef.current || openRef.current || stoppingRef.current || isProcessing) return;
    startingRef.current = true;
    abandonedRef.current = false;
    try {
      const { expoAudio: audioModule, audioRecorder: recorder } = ensureAudioSupport();
      // Pin cleanup and processing choices before permission/status awaits.
      jobRouteRef.current = cleanup
        ? snapshotTranscriptionJob('dictation')
        : { ...snapshotTranscriptionJob('dictation', []), cleanupUnavailable: CLEANUP_OFF };
      let liveChoice: { model: MlKitModelKey; locale: string } | null = null;
      if (
        options.liveTranscription &&
        Platform.OS === 'android' &&
        jobRouteRef.current.provider === 'local'
      ) {
        const { getPickedLocalModel } =
          require('../lib/inferenceRouting') as typeof import('../lib/inferenceRouting');
        const { useConfigStore } =
          require('../store/useConfigStore') as typeof import('../store/useConfigStore');
        const model = getPickedLocalModel('dictation');
        if (isMlKitModelKey(model)) {
          if (!AndroidSpeech.isLiveAvailable()) {
            throw new Error(
              'Live ML Kit speech needs the updated Android app. Install the latest native build.',
            );
          }
          const locale = mlKitLocale(useConfigStore.getState().config);
          if (!locale) throw new Error('Choose one transcription language for live ML Kit speech.');
          liveChoice = { model, locale };
        }
      }

      // Check status before requesting: iOS shows its system dialog only on
      // the very first-ever request for this install. If canAskAgain is
      // already false here, the upcoming request call is guaranteed to
      // return silently with no native UI.
      const priorStatus = await audioModule.AudioModule.getRecordingPermissionsAsync();
      const nativePromptShown = !priorStatus.granted && priorStatus.canAskAgain;

      const { granted, canAskAgain } =
        await audioModule.AudioModule.requestRecordingPermissionsAsync();
      if (!granted) {
        throw new MicPermissionError('Microphone permission not granted', {
          canAskAgain,
          nativePromptShown,
        });
      }

      if (liveChoice) {
        const { model, locale } = liveChoice;
        const status = await AndroidSpeech.getStatus(mlKitMode(model), locale);
        if (status.status !== 'available') {
          throw new Error(
            'The selected ML Kit model is not ready. Download or check it in AI Models.',
          );
        }
        if (!mountedRef.current || !appActiveRef.current) return;
        const session: LiveRecordingSession = {
          id: `live-${randomUUID()}`,
          model,
          locale,
          phase: 'starting',
          cancelled: false,
          retainHistory: saveToHistory,
          error: null,
          subscription: null,
        };
        liveSessionRef.current = session;
        setCurrentText('');
        setLiveLevel(0);
        session.subscription = AndroidSpeech.addLiveListener((event) => {
          if (
            !mountedRef.current ||
            event.sessionId !== session.id ||
            liveSessionRef.current !== session ||
            session.cancelled
          )
            return;
          if (event.type === 'transcript') setCurrentText(event.text);
          else if (event.type === 'level') setLiveLevel(Math.max(0, Math.min(1, event.level)));
          else {
            session.error = Object.assign(new Error(event.message), { code: event.code });
            if (session.phase === 'recording') void stopRef.current().catch(() => undefined);
          }
        });
        await AndroidSpeech.startLive(session.id, mlKitMode(model), locale);
        if (session.cancelled || !mountedRef.current) {
          await AndroidSpeech.cancelLive(session.id).catch(() => undefined);
          return;
        }
        session.phase = 'recording';
        openRef.current = true;
        setIsLiveTranscription(true);
        setIsRecording(true);
        if (session.error) void stopRef.current().catch(() => undefined);
        return;
      }

      if (Platform.OS === 'android' && allowsBackgroundRecording) {
        const notificationPermission =
          await audioModule.AudioModule.requestNotificationPermissionsAsync();
        if (!notificationPermission.granted) {
          throw new Error(
            'Notification permission is required to keep recording in the background.',
          );
        }
      }

      try {
        await audioModule.AudioModule.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: 'mixWithOthers',
          shouldPlayInBackground: allowsBackgroundRecording,
          shouldRouteThroughEarpiece: false,
          allowsBackgroundRecording,
        });
      } catch (audioModeError) {
        console.warn('[audio] Failed to set audio mode:', audioModeError);
      }

      // Release any stale state from a previous recording attempt.
      if (recorder.isRecording) {
        try {
          await recorder.stop();
        } catch {}
      }

      await recorder.prepareToRecordAsync(recorderOptions);
      await recorder.record();
      openRef.current = true;

      setIsRecording(true);
      setCurrentText('');
    } catch (error) {
      const session = liveSessionRef.current;
      if (session?.phase === 'starting') {
        session.subscription?.remove();
        liveSessionRef.current = null;
        await AndroidSpeech.cancelLive(session.id).catch(() => undefined);
      }
      if (abandonedRef.current || !mountedRef.current) return;
      // Permission denial is a normal user state — surfaced by onError as a
      // friendly alert. Skip console.error so dev LogBox doesn't show a red toast.
      if (!isMicPermissionError(error)) {
        console.error('[audio] Start recording error:', error);
      }
      if (error instanceof Error) {
        options.onError?.(error);
      }
      throw error;
    } finally {
      startingRef.current = false;
    }
  };

  const stopRecording = async () => {
    const liveSession = liveSessionRef.current;
    if (liveSession) {
      await stopLiveRecording(liveSession);
      return;
    }
    let sourceUriToDiscard: string | null = null;
    try {
      const { audioRecorder: recorder } = ensureAudioSupport();

      if (!isRecording || stoppingRef.current) {
        return;
      }

      stoppingRef.current = true;
      try {
        await recorder.stop();
        openRef.current = false;
      } finally {
        stoppingRef.current = false;
      }

      const uri = recorder.uri;
      if (!saveToHistory) sourceUriToDiscard = uri ?? null;

      setIsRecording(false);
      setIsProcessing(true);

      if (!uri) {
        throw new Error('No recording URI - recorder may not have started properly');
      }

      const fileInfo = await FileSystem.getInfoAsync(uri).catch((error) => {
        console.warn('[audio] Could not verify recording file:', error);
        return null;
      });

      if (fileInfo) {
        if (!fileInfo.exists) {
          throw new Error(
            'Recording file was not created. Audio recording may not work in the iOS Simulator. Please try on a physical device.',
          );
        }
        if (fileInfo.size === 0) {
          throw new Error(
            'Recording file is empty. No audio was captured. This may be a simulator limitation.',
          );
        }
      }

      const speechAnalysis = await analyzeSpeechActivity(uri, 'recording');
      if (speechAnalysis?.noSpeechLikely) {
        throw createNoSpeechError();
      }
      const clientTranscriptionId = `recording-${randomUUID()}`;

      const retained = await retainRecording(uri);
      sourceUriToDiscard = null;
      const transcriptionProvider = jobRouteRef.current.provider;
      try {
        await finalizeRecording(retained, transcriptionProvider, clientTranscriptionId);
      } catch (transcribeError) {
        if (isCancelled()) {
          await discardRetainedAudio(retained);
          return;
        }
        if (isNoSpeechError(transcribeError)) {
          await deleteManagedTranscriptAudio(retained.audioUrl);
          throw new Error(NO_SPEECH_ERROR_MESSAGE);
        }
        // Private mode with no on-device model. Never upload silently — hand the
        // choice to the caller. The recording is kept so an approved cloud retry
        // can reuse it without re-recording.
        if (
          transcriptionProvider === 'local' &&
          isLocalModelMissingError(transcribeError) &&
          options.onLocalModelMissing
        ) {
          if (saveToHistory) {
            await addFailedRecording(retained, transcriptionProvider, transcribeError);
          }
          options.onLocalModelMissing(
            () => {
              retryWithCloud(retained, clientTranscriptionId);
            },
            () => (saveToHistory ? Promise.resolve() : discardRetainedAudio(retained)),
          );
          return;
        }
        // Cloud quota exhausted. Keep the recording so an approved retry can
        // reuse it, then hand the billing/retry decision to the caller.
        if (isUsageLimitError(transcribeError) && options.onUsageLimitReached) {
          if (saveToHistory) {
            await addFailedRecording(retained, transcriptionProvider, transcribeError);
          }
          await options.onUsageLimitReached(transcribeError, () =>
            retryWithCloud(retained, clientTranscriptionId),
          );
          // Recovery is over, retried or declined; a retry already removed it.
          if (!saveToHistory) await discardRetainedAudio(retained);
          return;
        }
        if (saveToHistory) {
          await addFailedRecording(retained, transcriptionProvider, transcribeError);
        } else {
          await discardRetainedAudio(retained);
        }
        throw transcribeError;
      }
    } catch (error) {
      if (isCancelled()) return;
      options.onError?.(error as Error);
      throw error;
    } finally {
      // Retention normally removes the source. An ephemeral question must also lose it when
      // validation or copying fails before managed audio can take ownership.
      if (sourceUriToDiscard) {
        await FileSystem.deleteAsync(sourceUriToDiscard, { idempotent: true }).catch(
          () => undefined,
        );
      }
      setIsProcessing(false);
    }
  };

  const retainRecording = async (uri: string): Promise<RetainedRecordingAudio> => {
    const id = createTranscriptId();
    const audioFileName = fileNameFromUri(uri);
    const audioMimeType = mimeTypeFromFileName(audioFileName);
    const audioUrl = await retainTranscriptAudio(uri, {
      transcriptId: id,
      audioFileName,
      audioMimeType,
    });
    return { id, audioUrl, audioFileName, audioMimeType };
  };

  // Never lets a cleanup failure replace the result or error being reported.
  const discardRetainedAudio = async (retained: RetainedRecordingAudio): Promise<void> => {
    await deleteManagedTranscriptAudio(retained.audioUrl).catch(() => undefined);
  };

  const addFailedRecording = async (
    retained: RetainedRecordingAudio,
    provider: TranscriptionProvider,
    error: unknown,
  ) => {
    try {
      await addFailedTranscript({
        id: retained.id,
        audioUrl: retained.audioUrl,
        audioFileName: retained.audioFileName,
        audioMimeType: retained.audioMimeType,
        provider,
        inferenceRoute: provider === 'byok' ? jobRouteRef.current.inferenceRoute : undefined,
        cleanupRoute: jobRouteRef.current.cleanupRoute,
        cleanupUnavailable: jobRouteRef.current.cleanupUnavailable,
        requestContext: 'recording',
        jobId: retained.id,
        errorMessage: toFriendlyTranscriptionErrorMessage(error),
      });
    } catch (failedRowError) {
      if (__DEV__) {
        console.warn('[audio] Failed to save retryable failed transcript:', failedRowError);
      }
    }
  };

  const finalizeRecording = async (
    retained: RetainedRecordingAudio,
    provider: TranscriptionProvider,
    clientTranscriptionId: string,
    captured?: { response: TranscriptionResponse & { provider: 'local' }; locale: string },
  ) => {
    if (isCancelled()) {
      await discardRetainedAudio(retained);
      return;
    }
    const request: TranscriptionRequest = {
      ...jobRouteRef.current,
      audioUri: retained.audioUrl,
      provider,
      inferenceRoute: provider === 'byok' ? jobRouteRef.current.inferenceRoute : undefined,
      cleanupRoute: jobRouteRef.current.cleanupRoute,
      cleanupUnavailable: jobRouteRef.current.cleanupUnavailable,
      language: captured?.locale ?? getPreferredTranscriptionLanguage(),
      fileName: retained.audioFileName,
      mimeType: retained.audioMimeType,
      requestContext: 'recording',
      // Meetings end through stopRecordingRaw and never reach this upload.
      purpose: 'dictation',
      jobId: retained.id,
      clientTranscriptionId,
    };
    const lifecycle = {
      onRawTranscript: (text: string) => {
        if (!captured || mountedRef.current) setCurrentText(text);
      },
      shouldCancel: isCancelled,
    };
    const processedResult = captured
      ? await completeRecordedTranscription(
          { ...request, provider: 'local' },
          captured.response,
          lifecycle,
        )
      : await transcribeAndCleanup(request, lifecycle);

    if (isCancelled()) {
      await discardRetainedAudio(retained);
      return;
    }
    // Snippets expand only the final text; originalText stays the transcript as heard.
    const finalText = cleanup ? processedResult.text : processedResult.originalText;
    if (!finalText.trim()) {
      throw new Error(NO_SPEECH_ERROR_MESSAGE);
    }

    if (!saveToHistory) {
      await discardRetainedAudio(retained);
      setCurrentText(finalText);
      options.onComplete?.(finalText);
      return;
    }

    // The transcript is already paid for, so a history write failure must not lose it.
    const saved = await addTranscript({
      id: retained.id,
      text: finalText,
      originalText: processedResult.originalText,
      audioUrl: retained.audioUrl,
      audioFileName: retained.audioFileName,
      audioMimeType: retained.audioMimeType,
      duration: processedResult.transcription.duration,
      provider: processedResult.transcription.provider,
      inferenceRoute: processedResult.transcription.inferenceRoute,
      cleanupRoute: processedResult.transcription.cleanupRoute,
      cleanupUnavailable: processedResult.transcription.cleanupUnavailable,
      cleanupWarning: processedResult.transcription.cleanupWarning,
      requestContext: 'recording',
      jobId: retained.id,
    }).then(
      () => true,
      () => false,
    );

    if (!captured || mountedRef.current) {
      setCurrentText(finalText);
      options.onComplete?.(finalText);
      if (!saved) options.onError?.(new Error('Your transcript could not be saved to history.'));
    }
  };

  const stopLiveRecording = async (session: LiveRecordingSession): Promise<void> => {
    if (session.phase !== 'recording' || stoppingRef.current || session.cancelled) return;
    session.phase = 'stopping';
    stoppingRef.current = true;
    setIsRecording(false);
    setIsProcessing(true);
    let retained: RetainedRecordingAudio | null = null;
    let sourceUri: string | null = null;
    let nativeStopped = false;
    try {
      const result = await AndroidSpeech.stopLive(session.id);
      nativeStopped = true;
      openRef.current = false;
      sourceUri = result.fileUri;
      if (session.cancelled || (!mountedRef.current && !session.retainHistory) || isCancelled())
        return;
      retained = await retainRecording(result.fileUri);
      sourceUri = null;
      if (session.error || result.error) {
        throw (
          session.error ??
          Object.assign(new Error(result.error?.message ?? 'Live recognition failed.'), {
            code: result.error?.code,
          })
        );
      }
      if (!result.text.trim()) throw createNoSpeechError();
      await finalizeRecording(retained, 'local', `recording-${session.id}`, {
        locale: session.locale,
        response: {
          text: result.text,
          provider: 'local',
          duration: result.durationMs / 1000,
          endpoint: session.model,
        },
      });
    } catch (error: unknown) {
      if (session.cancelled || (!mountedRef.current && !session.retainHistory) || isCancelled()) {
        if (retained) await discardRetainedAudio(retained);
        return;
      }
      // A failed copy must not delete the original native WAV. Keep that cache
      // file on the failed row so the user can retry after freeing storage.
      if (!retained && sourceUri && session.retainHistory) {
        retained = {
          id: createTranscriptId(),
          audioUrl: sourceUri,
          audioFileName: fileNameFromUri(sourceUri),
          audioMimeType: 'audio/wav',
        };
        sourceUri = null;
      }
      if (retained) {
        if (!saveToHistory) await discardRetainedAudio(retained);
        else await addFailedRecording(retained, 'local', error);
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      if (mountedRef.current) options.onError?.(failure);
      throw failure;
    } finally {
      if (!nativeStopped) await AndroidSpeech.cancelLive(session.id).catch(() => undefined);
      session.subscription?.remove();
      if (liveSessionRef.current === session) liveSessionRef.current = null;
      openRef.current = false;
      stoppingRef.current = false;
      if (sourceUri)
        await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => undefined);
      if (mountedRef.current) {
        setIsRecording(false);
        setIsProcessing(false);
        setIsLiveTranscription(false);
        setLiveLevel(0);
      }
    }
  };
  stopRef.current = stopRecording;

  // Consented cloud transcription of an already-captured private-mode recording.
  const retryWithCloud = async (
    retained: RetainedRecordingAudio,
    clientTranscriptionId: string,
  ) => {
    setIsProcessing(true);
    try {
      // The private-mode snapshot pinned local text stages; a consented Cloud
      // upload should clean the way a Cloud recording would.
      jobRouteRef.current = cleanup
        ? { provider: 'cloud', ...snapshotTextInference('cloud') }
        : { provider: 'cloud', cleanupUnavailable: CLEANUP_OFF };
      await finalizeRecording(retained, 'cloud', clientTranscriptionId);
    } catch (error) {
      if (isCancelled()) {
        await discardRetainedAudio(retained);
        return;
      }
      if (isUsageLimitError(error) && options.onUsageLimitReached) {
        await options.onUsageLimitReached(error, () =>
          retryWithCloud(retained, clientTranscriptionId),
        );
        if (!saveToHistory) await discardRetainedAudio(retained);
        return;
      }
      if (!saveToHistory) {
        await discardRetainedAudio(retained);
      } else if (!isNoSpeechError(error)) {
        await addFailedRecording(retained, 'cloud', error);
      }
      options.onError?.(
        isNoSpeechError(error) ? new Error(NO_SPEECH_ERROR_MESSAGE) : (error as Error),
      );
    } finally {
      setIsProcessing(false);
    }
  };

  // A cancelled recording is discarded, so the file it was writing goes too. A recording another
  // stop already claimed is left to it, file and processing state alike. The claim is held until
  // the recording is gone, so a send landing meanwhile can't stop it again and read the deleted file.
  const cancelRecording = async (): Promise<void> => {
    const liveSession = liveSessionRef.current;
    if (liveSession) {
      liveSession.cancelled = true;
      abandonedRef.current = true;
      liveSession.subscription?.remove();
      await AndroidSpeech.cancelLive(liveSession.id).catch(() => undefined);
      // A claimed stop owns the returned WAV and deletes it after seeing cancellation.
      if (liveSession.phase !== 'stopping') liveSessionRef.current = null;
      openRef.current = false;
      if (mountedRef.current) {
        setIsRecording(false);
        setIsProcessing(false);
        setIsLiveTranscription(false);
        setCurrentText('');
        setLiveLevel(0);
      }
      return;
    }
    if (stoppingRef.current) return;
    if (!audioRecorder || (!audioRecorder.isRecording && !openRef.current)) {
      setIsRecording(false);
      return;
    }
    stoppingRef.current = true;
    // Read before stopping: the recorder may move on to a new file once it stops.
    const uri = audioRecorder.uri;
    try {
      const paused = !audioRecorder.isRecording;
      try {
        // A paused recorder ignores cancel; stopping it finishes the file so it can be deleted.
        await audioRecorder.stop();
      } catch (stopError) {
        if (!paused) throw stopError;
      }
      openRef.current = false;
      if (uri) {
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
      }
      setIsRecording(false);
      setIsProcessing(false);
      setCurrentText('');
    } finally {
      stoppingRef.current = false;
    }
  };
  cancelRef.current = cancelRecording;

  // Meeting-specific: stops recording and returns the raw URI without running the dictation finalize path.
  const stopRecordingRaw = async (): Promise<string | null> => {
    if (!audioRecorder.isRecording) return null;
    stoppingRef.current = true;
    try {
      await audioRecorder.stop();
      openRef.current = false;
    } finally {
      stoppingRef.current = false;
    }
    setIsRecording(false);
    setIsProcessing(false);
    return audioRecorder.uri ?? null;
  };

  return {
    isRecording,
    isProcessing,
    currentText,
    isLiveTranscription,
    liveLevel,
    isSupported,
    startRecording,
    stopRecording,
    stopRecordingRaw,
    cancelRecording,
    audioRecorder,
  };
}
