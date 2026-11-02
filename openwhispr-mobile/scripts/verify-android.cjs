const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const env = {
  ...process.env,
  OPENWHISPR_APP_ENV: process.env.OPENWHISPR_APP_ENV || 'development',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

run(process.execPath, [
  path.join(projectRoot, 'node_modules/expo/bin/cli'),
  'prebuild',
  '--platform',
  'android',
  '--no-install',
]);

const manifest = fs.readFileSync(
  path.join(projectRoot, 'android/app/src/main/AndroidManifest.xml'),
  'utf8',
);
for (const permission of ['RECORD_AUDIO', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE']) {
  assert.match(manifest, new RegExp(`android.permission.${permission}"`));
}
assert.match(manifest, /AudioRecordingService[^>]*android:foregroundServiceType="microphone"/);
const gradleProperties = fs.readFileSync(
  path.join(projectRoot, 'android/gradle.properties'),
  'utf8',
);
const minSdkVersion = gradleProperties.match(/^android.minSdkVersion=(\d+)$/m);
assert.ok(minSdkVersion && Number(minSdkVersion[1]) >= 26, 'ML Kit requires Android API 26+');
const rootGradle = fs.readFileSync(path.join(projectRoot, 'android/build.gradle'), 'utf8');
assert.ok(rootGradle.includes("kotlin-gradle-plugin:${findProperty('android.kotlinVersion')}"));
const application = manifest.match(/<application\b[^>]*>/)?.[0] || '';
assert.match(application, /android:fullBackupContent="@xml\/secure_store_backup_rules"/);
const backupReplacements = application.match(/tools:replace="([^"]*)"/)?.[1] || '';
assert.ok(backupReplacements.split(',').includes('android:fullBackupContent'));
assert.ok(backupReplacements.split(',').includes('android:dataExtractionRules'));

const autolinking = JSON.parse(
  run(
    process.execPath,
    [
      path.join(
        projectRoot,
        'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js',
      ),
      'resolve',
      '--platform',
      'android',
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  ),
);
assert.ok(
  autolinking.modules.some((module) =>
    module.projects.some((project) =>
      project.modules.some((nativeModule) =>
        nativeModule.classifier.endsWith('.AndroidSpeechModule'),
      ),
    ),
  ),
  'AndroidSpeechModule must be included in Android Expo autolinking',
);
console.log('Android prebuild, microphone service, and local speech autolinking verified.');

if (process.argv.includes('--build')) {
  // Invoke the checked-in wrapper JAR directly so Windows needs no shell or
  // executable .bat support, while JAVA_HOME selects the same JVM as gradlew.
  const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
  run(
    java,
    [
      '-classpath',
      'gradle/wrapper/gradle-wrapper.jar',
      'org.gradle.wrapper.GradleWrapperMain',
      ':app:assembleDebug',
      `-PreactNativeArchitectures=${process.env.ANDROID_BUILD_ARCHITECTURES || 'arm64-v8a'}`,
      '--no-daemon',
      '--console=plain',
    ],
    { cwd: path.join(projectRoot, 'android') },
  );
  console.log('Debug APK: android/app/build/outputs/apk/debug/app-debug.apk');
}
