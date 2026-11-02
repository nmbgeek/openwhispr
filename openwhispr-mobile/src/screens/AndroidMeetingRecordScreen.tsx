import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, StyleSheet, TextInput } from 'react-native';
import { usePreventRemove } from '@react-navigation/native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useAudioRecording } from '@/hooks/useAudioRecording';
import { getPickedLocalModel } from '@/lib/inferenceRouting';
import { mlKitLocale } from '@/lib/localSpeechModels';
import { getPrivateModeReadiness } from '@/lib/privateMode';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import { waitForAppActive } from '@/lib/meetingRecovery';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore, type MeetingSpeechOptions } from '@/store/useNotesStore';

type Phase = 'idle' | 'starting' | 'recording' | 'saving' | 'waiting' | 'processing' | 'failed';
type Session = { noteId: number; startedAt: number; speech: MeetingSpeechOptions };

/** Background capture is separate from foreground-only live dictation and speaker diarization. */
export function AndroidMeetingRecordScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [draft, setDraft] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState('On-device speech');
  const [saved, setSaved] = useState(false);
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ folderId?: string; spaceId?: string }>();
  const sessionRef = useRef<Session | null>(null);
  const draftRef = useRef('');
  const rawUriRef = useRef<string | null>(null);
  const captureErrorRef = useRef<Error | null>(null);
  const finishingRef = useRef(false);
  const startingRef = useRef(false);
  const mounted = useRef(true);
  const pendingFinish = useRef<{ error: Error | null } | null>(null);
  const finishRef = useRef<(error?: Error | null) => Promise<void>>(async () => undefined);

  const recording = useAudioRecording({
    allowsBackgroundRecording: true,
    liveTranscription: false,
    saveToHistory: false,
    onError: (failure) => {
      if (mounted.current) setError(failure.message);
    },
    onRecordingFinished: (failure) => {
      if (sessionRef.current) finishRef.current(failure).catch(() => undefined);
      else if (startingRef.current) pendingFinish.current = { error: failure };
    },
  });

  const saveDraft = (): void => {
    const session = sessionRef.current;
    if (session) useNotesStore.getState().updateNote(session.noteId, { content: draftRef.current });
  };
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') saveDraftRef.current();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      saveDraftRef.current();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const update = (): void => {
      if (sessionRef.current)
        setElapsed(Math.floor((Date.now() - sessionRef.current.startedAt) / 1000));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setTimeout(saveDraft, 600);
    return () => clearTimeout(timer);
  }, [draft, phase]);

  usePreventRemove(phase === 'recording' || phase === 'starting', () => {
    Alert.alert('Meeting is recording', 'Stop and save this recording before leaving.', [
      { text: 'Keep recording', style: 'cancel' },
      {
        text: 'Stop and save',
        onPress: () => {
          finishRef.current().catch(() => undefined);
        },
      },
    ]);
  });

  const markFailed = (noteId: number): void => {
    const store = useNotesStore.getState();
    const status = store.getNoteById(noteId)?.transcriptionStatus;
    if (status === 'recording' || status === 'transcribing' || status === 'diarizing')
      store.transitionStatus(noteId, 'failed');
  };

  const start = async (): Promise<void> => {
    if (startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    setPhase('starting');
    setError(null);
    const model = getPickedLocalModel('dictation') ?? 'whisper-base';
    const speech: MeetingSpeechOptions = {
      model,
      language: getPreferredTranscriptionLanguage() ?? 'auto',
      locale: mlKitLocale(useConfigStore.getState().config) ?? undefined,
    };
    try {
      const ready = await getPrivateModeReadiness(model ?? 'automatic');
      if (ready.status !== 'ready') {
        throw new Error(
          'Choose and download an on-device speech model in AI Models before recording a meeting.',
        );
      }
      setModelLabel(LocalTranscriptionService.preferredEngineDescriptor(model).label);
      await recording.startRecording();
      if (!recording.audioRecorder?.isRecording && !pendingFinish.current) {
        throw new Error(
          'Recording did not start. Keep OpenWhispr open while preparing the recorder and try again.',
        );
      }
      let note;
      try {
        note = useNotesStore.getState().createMeetingNote({
          folderId: params.folderId ? Number(params.folderId) : undefined,
          spaceId: params.spaceId ? Number(params.spaceId) : undefined,
          diarizationEnabled: false,
          isPrivate: true,
        });
      } catch (failure) {
        await recording.cancelRecording();
        throw failure;
      }
      sessionRef.current = { noteId: note.id, startedAt: Date.now(), speech };
      setPhase('recording');
      const pending = pendingFinish.current;
      pendingFinish.current = null;
      if (pending) finishRef.current(pending.error).catch(() => undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to start the meeting.');
      setPhase('idle');
    } finally {
      startingRef.current = false;
    }
  };

  const finish = async (nativeError: Error | null = null): Promise<void> => {
    const session = sessionRef.current;
    if (!session || finishingRef.current) return;
    finishingRef.current = true;
    captureErrorRef.current ??= nativeError;
    if (mounted.current) {
      setPhase('saving');
      setError(null);
    }
    try {
      saveDraft();
      const uri = rawUriRef.current ?? (await recording.stopRecordingRaw());
      if (!uri)
        throw new Error(
          'The recorder stopped without an available audio file. Your typed notes are saved.',
        );
      rawUriRef.current = uri;
      // Notification-stop delivery can be delayed while JS is asleep, so do not
      // pretend the wall clock is the audio duration for an external stop.
      const duration =
        nativeError === null && recording.isRecording
          ? Math.max(0, (Date.now() - session.startedAt) / 1000)
          : undefined;
      const retained = await useNotesStore
        .getState()
        .retainMeetingRecording(session.noteId, uri, duration);
      rawUriRef.current = retained;
      if (mounted.current) setSaved(true);
      if (captureErrorRef.current) throw captureErrorRef.current;
      const store = useNotesStore.getState();
      if (store.getNoteById(session.noteId)?.transcriptionStatus !== 'transcribing')
        store.transitionStatus(session.noteId, 'transcribing');
      if (mounted.current) setPhase('waiting');
      // ML Kit blocks background inference even when recording uses a foreground service.
      await waitForAppActive(AppState);
      if (mounted.current) setPhase('processing');
      await useNotesStore.getState().runMeetingPipeline(session.noteId, retained, undefined, {
        ...session.speech,
        durationSeconds: duration,
      });
      if (mounted.current) router.replace(`/(tabs)/(notes)/${session.noteId}`);
    } catch (failure) {
      markFailed(session.noteId);
      if (mounted.current) {
        setError(
          failure instanceof Error ? failure.message : 'The meeting could not be transcribed.',
        );
        setPhase('failed');
      }
    } finally {
      finishingRef.current = false;
    }
  };
  finishRef.current = finish;

  const busy =
    phase === 'starting' || phase === 'saving' || phase === 'waiting' || phase === 'processing';
  const recordingNow = phase === 'recording';
  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 24, 40) }]}
    >
      <Text accessibilityRole="header" className="text-2xl font-semibold text-label">
        Record meeting notes
      </Text>
      <Text className="text-base text-secondaryLabel">
        Recording continues when you switch apps or lock your phone. Android shows a recording
        notification with a Stop button.
      </Text>
      <Text className="text-sm text-secondaryLabel">
        This meeting starts private. Audio is transcribed on this device after Stop, while
        OpenWhispr is open. Speaker separation and automatic AI summaries are not included.
      </Text>
      {recordingNow ? (
        <Text
          testID="meeting-timer"
          className="text-4xl font-semibold text-label"
        >{`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}</Text>
      ) : null}
      {sessionRef.current ? (
        <Text className="text-sm text-secondaryLabel">{modelLabel} · On-device</Text>
      ) : null}
      <TextInput
        testID="android-meeting-notes"
        value={draft}
        onChangeText={(value) => {
          draftRef.current = value;
          setDraft(value);
        }}
        multiline
        placeholder="Jot decisions, follow-ups, or context…"
        placeholderTextColor="#777"
        textAlignVertical="top"
        className="min-h-[200px] rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4 text-base text-label"
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-systemRed">
          {error}
        </Text>
      ) : null}
      {phase === 'idle' ? (
        <>
          <Button
            testID="android-meeting-start"
            onPress={() => {
              start().catch(() => undefined);
            }}
          >
            Start recording
          </Button>
          <Button variant="secondary" onPress={() => router.push('/(account)/ai-models')}>
            Choose speech model
          </Button>
        </>
      ) : recordingNow ? (
        <Button
          testID="android-meeting-stop"
          variant="destructive"
          onPress={() => {
            finish().catch(() => undefined);
          }}
        >
          Stop and transcribe
        </Button>
      ) : null}
      {busy ? (
        <Text className="text-secondaryLabel">
          {phase === 'starting'
            ? 'Preparing recorder…'
            : phase === 'saving'
              ? 'Saving recording…'
              : phase === 'waiting'
                ? 'Recording saved. Waiting for OpenWhispr to be active…'
                : 'Transcribing on this device…'}
        </Text>
      ) : null}
      {phase === 'failed' ? (
        <>
          <Text className="text-secondaryLabel">
            {saved
              ? 'Your recording and typed notes are saved. Retry transcription from the note.'
              : 'Your typed notes are saved. The original recording has not been deleted; retry saving before leaving.'}
          </Text>
          {!saved && rawUriRef.current ? (
            <Button
              onPress={() => {
                finish(captureErrorRef.current).catch(() => undefined);
              }}
            >
              Retry saving recording
            </Button>
          ) : null}
          {sessionRef.current ? (
            <Button
              variant="secondary"
              onPress={() => router.replace(`/(tabs)/(notes)/${sessionRef.current?.noteId}`)}
            >
              Open saved note
            </Button>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ content: { padding: 20, gap: 18 } });
