# Android speech

Local Expo module for Android audio decoding, optional ML Kit speech recognition, and battery settings. It has no iOS registration and no network inference fallback.

## Engines and availability

Whisper uses `convertToWav` to decode Android recordings and imported audio with `MediaExtractor` and `MediaCodec`. The converter writes a new PCM16 WAV file in the app cache, preserving sample rate and channel count. The caller owns this file and must delete it in `finally` after inference. Incomplete, empty, unsupported, and oversized output fails rather than returning a partial recording.

ML Kit Basic and Advanced are separate user choices. `getStatus(mode, locale)` checks the actual selected mode and language on the device. Basic needs Android 12 or later. Advanced also needs supported Google on-device services and hardware. An eligible phone can still report unavailable while Google services initialize or update. Do not infer availability from a device model name.

`download` only runs after an explicit user action. `transcribe` requires an available model and one explicit language, reads the whole local audio file, and does not download models or fall back to cloud inference. Only final text is saved. The SDK must send its completion response before the operation succeeds. File transcription does not request word timings, which the SDK supports only for streaming input.

Basic file transcription decodes locally, downmixes and linearly resamples to PCM16 mono at 16 kHz, then feeds a nonblocking pipe at recording speed. This avoids an observed device-service limitation where Basic reported `NO_SPEECH_DETECTED` for valid `ONE_SHOT` WAV and PCM files but recognized the identical paced PCM through `STREAMING`. Full-input delivery and SDK completion are both required, so early service termination never saves a truncated transcript as success. Basic currently needs microphone permission even for file input, despite never opening a microphone for that path. Its permission error explains the requirement and offers Whisper for file-only use. Advanced files retain `ONE_SHOT` processing.

The module pins `genai-speech-recognition:1.0.0-alpha2`. Its transitive `genai-common:1.0.0-beta5` provides `AudioSource.fromUri` and whole-file recognition. The documentation's alpha1 dependency example is older than these APIs. Signatures were checked against the official Maven AARs with `javap`. ML Kit remains an alpha dependency.

Status checks time out after 15 seconds, model preparation after 10 minutes, and audio conversion or transcription after 30 minutes. A timeout fails the operation and discards incomplete results. Downloads and inference are exclusive. `cancel` waits for the active operation's cleanup; module destruction also cancels it. Native recognizers and audio sources are closed on completion, errors, and cancellation.

## Live recording

`startLive(sessionId, mode, locale)` starts one native `AudioRecord` at PCM16 mono/16 kHz. The same audio is retained as WAV and streamed to ML Kit; there is no second Expo recorder. Subscribers receive complete transcript snapshots, normalized microphone levels and session-scoped errors. Partial hypotheses replace the current partial text; only final SDK results are committed.

`stopLive` stops capture, drains the bounded audio queue and waits for SDK completion. It returns `{text, fileUri, durationMs}` and an optional `{code, message}` error. An SDK error retains the WAV but never converts a partial transcript into success. The caller owns the returned file, including after a failure, and must delete it when no longer needed. A cancel after completed stop does not delete audio already transferred to the caller.

Active capture stays outside the managed retry directory so startup garbage collection cannot mistake it for an unreferenced recording. After capture stops and the WAV is finalized, the file is atomically renamed into `cache/transcript-audio/` before its URI is returned. JavaScript recognizes that managed URI and does not copy it again. If adoption fails, the original cache file is preserved and the stop result reports `AUDIO_RETENTION` with the original URI. Retry audio intentionally remains in app cache rather than backed-up documents storage.

`cancelLive` invalidates pending starts, releases the microphone, closes pipes and the SDK client, and deletes active-session audio. The app cancels live capture when it leaves the foreground; this module does not promise background live recognition. Session IDs reject stale stop/cancel calls, and live recording is exclusive with file recognition, conversion and downloads. Recording is limited to 30 minutes; stop and SDK draining are bounded. `isLiveAvailable()` lets JavaScript detect an older binary without this native API.

## Battery settings

`isBatteryOptimizationExempt` reads the actual `PowerManager` exemption. `openBatteryOptimizationSettings` opens Android's battery optimization list only when called by the UI, with the application's settings as a fallback. The user can grant or revoke exemption there. No restricted direct-exemption permission is declared. Returning from settings does not imply approval; re-read the status.

## Validation

Build the Android application after prebuild so Expo autolinking registers `expo.modules.androidspeech.AndroidSpeechModule`. Hardware acceptance must cover downloaded Basic and Advanced models, unsupported phones/languages, airplane-mode transcription, cancellation, M4A and WAV input, long recordings, and an exemption granted or declined in system settings.

With an emulator or test device connected, run the native conversion acceptance tests from the generated `android` directory:

```sh
./gradlew :android-speech:connectedDebugAndroidTest
```

These tests decode real stereo WAV and AAC/M4A audio, inspect PCM16 samples, sample rate, channels and duration, and exercise invalid-input and cancellation cleanup. The AAC fixture is generated with the device's encoder during the test, so no external codec or binary fixture is required. They do not claim ML Kit model support on an emulator.

For a read-only device capability probe, select the dedicated test class:

```sh
ANDROID_SERIAL=<device-serial> ./gradlew :android-speech:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=expo.modules.androidspeech.AndroidSpeechCapabilityProbeTest
adb -s <device-serial> logcat -d -s OpenWhisprMLKitProbe:I '*:S'
```

The probe logs Basic and Advanced status for `en-US`, including service error reasons. It uses fresh clients twice per mode, bounds each status request to 15 seconds, and verifies that every created client closes. It does not download models, use the microphone, or establish recognition quality.

`BasicFileSpeechRecognizerTest` recognizes the known synthetic speech fixture after native stereo/44.1 kHz conversion and checks full-text and cache cleanup. `AndroidSpeechStreamingProbeTest` exercises the SDK's paced streaming input directly. The fixture is synthetic PCM16 mono/16 kHz speech, not a user recording. `AndroidLiveSpeechSessionTest` briefly opens the microphone to verify cancellation, pending-start invalidation, error recovery and transferred-WAV ownership; it does not assess recognition accuracy from ambient sound. Recognition tests skip devices without an already available Basic model and never download models themselves.

Sources: [ML Kit speech](https://developers.google.com/ml-kit/genai/speech-recognition/android), [Google Maven versions](https://dl.google.com/dl/android/maven2/com/google/mlkit/genai-speech-recognition/maven-metadata.xml), and [Android Doze exemptions](https://developer.android.com/training/monitoring-device-state/doze-standby).
