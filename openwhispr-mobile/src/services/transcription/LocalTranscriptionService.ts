import type { ParakeetVersion } from '../../../modules/parakeet-asr/src';
import type { TranscriptionResponse } from '../../types';
import type { LocalModelKey } from '../../lib/localModelCatalog';
import { Platform } from 'react-native';
import { AndroidSpeech } from '../../../modules/android-speech/src';
import {
  isMlKitModelKey,
  mlKitMode,
  mlKitLocale,
  ML_KIT_TITLES,
  type LocalSpeechModelKey,
} from '../../lib/localSpeechModels';
import { getPreferredTranscriptionLanguages } from '../../lib/transcriptionLanguage';
import { LocalParakeetService } from './LocalParakeetService';
import { LocalWhisperService } from './LocalWhisperService';
import {
  selectLocalEngine,
  preferredEngineForLanguages,
  type LocalEngineAvailability,
  type LocalEngineChoice,
} from './localEngine';

export interface LocalEngineDescriptor {
  engine: 'parakeet' | 'whisper' | 'mlkit';
  version?: ParakeetVersion;
  label: string;
}

function configuredMlKitLocale(): string | null {
  const { useConfigStore } =
    require('../../store/useConfigStore') as typeof import('../../store/useConfigStore');
  return mlKitLocale(useConfigStore.getState().config);
}

export interface LocalTranscribeOptions {
  /** Single-language hint for the Whisper branch (today's behavior, passed through verbatim). */
  language?: string;
  wordTimestamps?: boolean;
  /** Whisper initial prompt (dictionary/snippet hints). Parakeet has no prompt input — dropped there. */
  prompt?: string;
  /** The model picked for this workflow; unset or unusable means the automatic choice. */
  model?: LocalSpeechModelKey;
}

function descriptorFor(
  preferred: ReturnType<typeof preferredEngineForLanguages>,
): LocalEngineDescriptor {
  if (preferred.engine === 'parakeet') {
    return {
      engine: 'parakeet',
      version: preferred.version,
      label: preferred.version === 'v2' ? 'Parakeet v2' : 'Parakeet v3',
    };
  }
  return { engine: 'whisper', label: 'Whisper base' };
}

function missingModelError(choice: Extract<LocalEngineChoice, { engine: 'none' }>): Error {
  const label =
    choice.preferred === 'whisper'
      ? 'Whisper'
      : choice.preferred === 'parakeet-v2'
        ? 'Parakeet v2'
        : 'Parakeet v3';
  // Message must satisfy isLocalModelMissingError (TranscriptionService.ts) so the Home
  // screen's download-or-cloud-once prompt keeps working.
  return new Error(`Model "${label}" is not available. Please download it first from Settings.`);
}

/**
 * Single entry point for on-device transcription. Routes each request to Parakeet (v2/v3) or
 * Whisper based on the user's selected languages and which models are installed — callers never
 * pick an engine themselves. Routing policy lives in localEngine.ts.
 */
export class LocalTranscriptionService {
  static isAvailable(): boolean {
    return (
      LocalWhisperService.isAvailable() ||
      LocalParakeetService.isAvailable() ||
      AndroidSpeech.isAvailable()
    );
  }

  static async getAvailability(): Promise<LocalEngineAvailability> {
    const parakeetSupported = LocalParakeetService.isAvailable();
    const [parakeetV2Downloaded, parakeetV3Downloaded] = parakeetSupported
      ? await Promise.all([
          LocalParakeetService.isModelDownloaded('v2'),
          LocalParakeetService.isModelDownloaded('v3'),
        ])
      : [false, false];

    const whisperModels = LocalWhisperService.isAvailable()
      ? await LocalWhisperService.getAvailableModels()
      : [];

    return {
      parakeetSupported,
      parakeetV2Downloaded,
      parakeetV3Downloaded,
      // The fallback tier is specifically multilingual Whisper base. English-only or smaller
      // legacy artifacts must not make unsupported-language routes appear ready.
      whisperDownloaded: whisperModels.some((model) => model.name === 'base' && model.downloaded),
    };
  }

  private static async resolveEngine(model?: LocalModelKey): Promise<{
    languages: string[];
    choice: LocalEngineChoice;
  }> {
    const languages = getPreferredTranscriptionLanguages();
    const availability = await this.getAvailability();
    return { languages, choice: selectLocalEngine(languages, availability, model) };
  }

  static async transcribe(
    audioUri: string,
    options: LocalTranscribeOptions = {},
  ): Promise<TranscriptionResponse> {
    if (isMlKitModelKey(options.model)) {
      const model = options.model;
      const locale = configuredMlKitLocale();
      if (Platform.OS !== 'android' || !AndroidSpeech.isAvailable()) {
        throw new Error(`${ML_KIT_TITLES[model]} is only available in a native Android build.`);
      }
      if (!locale) {
        throw new Error(
          'Choose one transcription language for ML Kit, or select Whisper for auto-detect and multiple languages.',
        );
      }
      const status = await AndroidSpeech.getStatus(mlKitMode(model), locale);
      if (status.status !== 'available') {
        throw new Error(
          `${ML_KIT_TITLES[model]} is not available for ${locale}. Download or check the model in AI Models, or select Whisper.`,
        );
      }
      if (options.wordTimestamps) {
        throw new Error(
          'ML Kit file transcription does not provide word timestamps. Select Whisper for this recording.',
        );
      }
      await Promise.all([LocalWhisperService.cleanup(), LocalParakeetService.cleanup()]);
      const startedAt = Date.now();
      const result = await AndroidSpeech.transcribe(audioUri, mlKitMode(model), locale);
      return {
        text: result.text,
        duration: (Date.now() - startedAt) / 1000,
        provider: 'local',
        endpoint: model,
        processingMs: Date.now() - startedAt,
      };
    }
    const { languages, choice } = await this.resolveEngine(options.model);

    if (choice.engine === 'parakeet') {
      // Don't keep both runtimes' weights resident (~600 MB + ~500 MB) — release the idle one.
      await LocalWhisperService.cleanup();
      const response = await LocalParakeetService.transcribe(audioUri, {
        version: choice.version,
        // Exactly one selected language → pass the decoder hint; multi-in-v3 → auto language ID.
        language: languages.length === 1 ? languages[0] : undefined,
        wordTimestamps: options.wordTimestamps,
      });
      return { ...response, endpoint: `parakeet-${choice.version}` };
    }

    if (choice.engine === 'whisper') {
      await LocalParakeetService.cleanup();
      const modelName = await LocalWhisperService.getRecommendedModelForLanguage(options.language);
      const response = await LocalWhisperService.transcribe(audioUri, {
        modelName,
        language: options.language,
        wordTimestamps: options.wordTimestamps,
        prompt: options.prompt,
      });
      return { ...response, endpoint: `whisper-${modelName}` };
    }

    throw missingModelError(choice);
  }

  /**
   * Warm the engine the current language selection routes to (keyboard/Home pre-warm path).
   * Never downloads; a Parakeet choice that isn't installed resolves to Whisper or a no-op.
   */
  static async prepareForLanguage(language?: string, model?: LocalSpeechModelKey): Promise<void> {
    // ML Kit preparation/download is an explicit action in settings, never a background download.
    if (isMlKitModelKey(model)) return;
    const { choice } = await this.resolveEngine(model);
    if (choice.engine === 'parakeet') {
      await LocalParakeetService.prepare(choice.version);
      return;
    }
    if (choice.engine === 'whisper') {
      await LocalWhisperService.prepareForLanguage(language);
    }
  }

  /** True when the engine the current selection routes to has its model installed. */
  static async isReadyForLanguage(model?: LocalSpeechModelKey): Promise<boolean> {
    if (isMlKitModelKey(model)) {
      const locale = configuredMlKitLocale();
      if (Platform.OS !== 'android' || !AndroidSpeech.isAvailable() || !locale) return false;
      const status = await AndroidSpeech.getStatus(mlKitMode(model), locale);
      return status.status === 'available';
    }
    const { choice } = await this.resolveEngine(model);
    return choice.engine !== 'none';
  }

  /** Display descriptor for the engine the current selection *should* use (installed or not). */
  static preferredEngineDescriptor(model?: LocalSpeechModelKey): LocalEngineDescriptor {
    if (isMlKitModelKey(model)) return { engine: 'mlkit', label: ML_KIT_TITLES[model] };
    if (Platform.OS === 'android') return { engine: 'whisper', label: 'Whisper base' };
    return descriptorFor(preferredEngineForLanguages(getPreferredTranscriptionLanguages()));
  }

  static async cancelTranscription(): Promise<void> {
    await Promise.all([
      LocalWhisperService.cancelTranscription(),
      LocalParakeetService.cancelTranscription(),
      AndroidSpeech.cancel(),
    ]);
  }
}
