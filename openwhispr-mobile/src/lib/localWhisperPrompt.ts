import type { TranscriptionRequest } from '@/types';
import { buildDictationHintTiers, isDictationContext } from './dictationHints';
import {
  WHISPER_PROMPT_CHARS,
  MAX_SHARED_KEYTERMS,
  PROMPT_HEAD_TERMS,
  formatDictionaryPrompt,
  promptLimitKeepingPersonal,
  sharedDictionaryPromptChars,
} from './transcriptionPromptCap';

// Dictionary words and dictation-only snippet triggers use the same initial
// prompt for batch and live Whisper. Shared hints fill only the decoder window;
// the user's personal hints are never cut and remain at the prompt's tail.
export function buildLocalWhisperPrompt(
  requestContext: TranscriptionRequest['requestContext'],
): string | undefined {
  const promptTiers = buildDictationHintTiers(isDictationContext(requestContext));
  return (
    formatDictionaryPrompt(
      promptTiers,
      promptLimitKeepingPersonal(promptTiers, WHISPER_PROMPT_CHARS),
      {
        sharedChars: sharedDictionaryPromptChars(WHISPER_PROMPT_CHARS),
        sharedWords: MAX_SHARED_KEYTERMS,
        totalTerms: PROMPT_HEAD_TERMS,
      },
    ) || undefined
  );
}
