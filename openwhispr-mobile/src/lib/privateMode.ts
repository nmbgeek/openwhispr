import { Alert } from 'react-native';
import { router } from 'expo-router';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { getPickedLocalModel } from '@/lib/inferenceRouting';
import { isLocalSpeechModelKey } from '@/lib/localSpeechModels';

export type PrivateModeStatus = 'ready' | 'missing' | 'unavailable';

export interface PrivateModeReadiness {
  status: PrivateModeStatus;
  /** Display label of the engine the user's language selection routes to (e.g. "Parakeet v2"). */
  modelName: string;
}

/**
 * Whether private mode can transcribe right now: the engine the user's language selection
 * routes to has its model downloaded. Explicit ML Kit selections also check device and locale
 * support. With no argument this checks the current dictation choice.
 */
export async function getPrivateModeReadiness(
  selectedModel?: string,
): Promise<PrivateModeReadiness> {
  const model =
    selectedModel === undefined
      ? getPickedLocalModel('dictation')
      : isLocalSpeechModelKey(selectedModel)
        ? selectedModel
        : undefined;
  const modelName = LocalTranscriptionService.preferredEngineDescriptor(model).label;

  if (!LocalTranscriptionService.isAvailable()) {
    return { status: 'unavailable', modelName };
  }

  const ready = await LocalTranscriptionService.isReadyForLanguage(model);
  return { status: ready ? 'ready' : 'missing', modelName };
}

export function getPrivateModeUnavailableMessage(): string {
  return 'Build OpenWhispr with native modules enabled before using on-device transcription.';
}

// Private mode with no on-device model. We never upload automatically — the
// user explicitly chooses to download the model or send this one recording to
// the cloud. onDecline runs for either choice that leaves this recording untranscribed.
export function promptLocalModelFallback(onUseCloudOnce: () => void, onDecline?: () => void): void {
  Alert.alert(
    'On-device model unavailable',
    "The model for private dictation isn't downloaded, so this recording can't be transcribed on your device. Send it to the cloud instead?",
    [
      { text: 'Cancel', style: 'cancel', onPress: onDecline },
      {
        text: 'Download Model',
        onPress: () => {
          onDecline?.();
          router.push('/(account)/model-download');
        },
      },
      { text: 'Use Cloud Once', onPress: onUseCloudOnce },
    ],
  );
}
