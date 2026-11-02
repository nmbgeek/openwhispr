# Build and verify Android

Run these commands from `openwhispr-mobile/`. Install Node.js 24, JDK 17, and Android Studio with SDK 36 first. Set `ANDROID_HOME` to your Android SDK directory and `JAVA_HOME` to JDK 17.

## Create a development build

```sh
npm ci
npm run android
```

Use a development build. Expo Go does not contain Whisper or the custom Android speech module.

The app requires Android 8 or newer. ML Kit Basic additionally requires Android 12 or newer. Advanced requires a compatible device, and both modes check model availability at runtime.

To install beside the production app, use the development scripts above. They select the `.dev` Android package and `openwhispr-dev` URL scheme. To use your own identifiers, set `OPENWHISPR_ANDROID_PACKAGE`, `OPENWHISPR_SCHEME`, and `OPENWHISPR_DISPLAY_NAME` in `.env.local` before building.

## Check the native build

```sh
npm run verify:android
npm run build:android:debug
```

The first command regenerates the ignored `android/` project without deleting it. It checks microphone permissions, the foreground recording service, and speech-module autolinking. The second command also compiles an ARM64 debug APK at `android/app/build/outputs/apk/debug/app-debug.apk`.

For an Intel emulator build, set `ANDROID_BUILD_ARCHITECTURES=x86_64` before running the build command. For all supported ABIs, set `ANDROID_BUILD_ARCHITECTURES=armeabi-v7a,arm64-v8a,x86,x86_64`.

Mobile CI exports the Android JavaScript bundle and compiles an x86_64 debug APK. Compilation does not verify audio quality, background recording, billing, or device model support.

To exercise the real Android audio decoder on a connected device, run from the generated `android/` directory:

```sh
ANDROID_SERIAL=your-device-serial ./gradlew :android-speech:connectedDebugAndroidTest
```

These instrumentation tests check WAV samples and headers, complete AAC/M4A decoding, invalid-file cleanup, and cancellation cleanup. They do not download ML Kit models or test recognition accuracy.

To run the native decoder tests, connect a device with USB debugging enabled, then run this command from the generated `android/` directory:

```sh
./gradlew :android-speech:connectedDebugAndroidTest -PreactNativeArchitectures=arm64-v8a
```

If multiple devices are connected, set `ANDROID_SERIAL` to the target serial shown by `adb devices` before running the command. The tests encode AAC audio with Android's media APIs, decode WAV and AAC files, check the resulting PCM samples, and verify cancellation and invalid-file cleanup. Run instrumentation before manual UI checks because the test runner can change the foreground screen.

The live-session tests also open and release the device microphone to check cancellation and audio recovery. Finish any manual recording before running them.

## Check speech recognition on a device

For live text, open **Account > AI Models > Dictation**, choose **On-Device**, and select Whisper base or a ready ML Kit Basic or Advanced model. Home and Note Editor then display changing partial text while recording. Only the final transcript is saved. Failed sessions retain audio for retry; completed transcripts release their audio, following the existing privacy policy. ML Kit saves its final live result without another transcription pass. Whisper shows a rolling eight-second recent preview, then transcribes the entire retained recording once when you tap Done. The final text can differ from the draft. Whisper preview updates depend on device speed and may use more battery.

Basic file uploads process at playback speed. The app streams their decoded audio because the Basic service on the tested Samsung rejects the SDK's whole-file recognition mode. Advanced file uploads use whole-file recognition. Both routes stay on the device.

1. Complete onboarding without an iOS keyboard or Full Access requirement.
2. Download Whisper base and select On-Device for dictation or uploads.
3. Enable airplane mode, record speech, stop recording, and confirm the transcript is saved.
4. Import an audio file and confirm local transcription works without a network connection.
5. On an Android 12 or newer device, check ML Kit Basic availability for the selected language. Download its model explicitly if offered.
6. On a compatible device, repeat the check for ML Kit Advanced. An unsupported device must show an unavailable state.
7. Select each downloaded ML Kit mode, transcribe a recording, and repeat offline. Check that cancellation stops processing and leaves the original recording available.
8. Change the language to one the selected ML Kit mode cannot use. Confirm the app reports the limitation instead of sending audio to the cloud.

ML Kit speech recognition is an alpha API. Basic uses traditional on-device recognition. Advanced uses the device's supported Gemini model. Both availability and language support are determined at runtime. Initial model setup can require a network connection, updated Google system components, and free storage. See Google's [Speech Recognition API guide](https://developers.google.com/ml-kit/genai/speech-recognition/android).

## Check long recordings and system settings

1. Allow microphone access when prompted. Core dictation records in the foreground; keep the app open while recording. Live capture is cancelled if the app goes into the background. A recording you already stopped still finishes saving if you leave the screen. Background meeting recording is not part of this Android release.
2. Check interruptions, screen locking, and returning to the app on a physical device. Confirm that interruptions never produce a successful, silently truncated transcript.
3. Verify that failed recordings remain available for retry.
4. Open the battery optimization option in Preferences. Confirm that it shows the current exemption state and opens Android's system settings only after you tap it.
5. Return from system settings and verify that the displayed state refreshes. Denying an exemption must not block normal app use.

Battery optimization exemption does not grant microphone permission, enable background dictation, or guarantee uninterrupted processing. The build includes Expo's microphone foreground service for future background recording flows. Test both restricted and exempt states on a physical device. See Android's [Doze and App Standby guide](https://developer.android.com/training/monitoring-device-state/doze-standby).

## Prepare an Android release

The EAS `development` and `preview` profiles produce APKs. The `production` profile produces an Android App Bundle. The pre-install hook installs Ruby dependencies only for iOS builds.

Before publishing this fork, configure its Expo owner, EAS project, update URL, Android package, signing credentials, Google Play listing, and any billing integrations. The repository still contains the original project's release service identifiers. Local builds do not require changing those values, but publishing an independent app does.

Complete the device checks above on at least one baseline Android device and one ML Kit Advanced device before claiming support. Also verify authentication, note sync, imported audio, offline recovery, notification denial, incoming calls, Bluetooth input, billing, and Android Back navigation.

Android does not yet have the iOS audio-chunking module for large cloud uploads. Cloud imports remain subject to the server's single-upload limits.
