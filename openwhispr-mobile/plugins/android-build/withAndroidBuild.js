const {
  AndroidConfig,
  withAndroidManifest,
  withProjectBuildGradle,
} = require('expo/config-plugins');

const unversionedPlugin = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";
const versionedPlugin =
  'classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${findProperty(\'android.kotlinVersion\')}")';

// SDK 55's template leaves this classpath unversioned, so React Native's
// transitive compiler can win over expo-build-properties' android.kotlinVersion.
module.exports = function withAndroidBuild(config) {
  config = withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.contents.includes(versionedPlugin)) return mod;
    if (!mod.modResults.contents.includes(unversionedPlugin)) {
      throw new Error('Android Kotlin plugin declaration changed; review withAndroidBuild.');
    }
    mod.modResults.contents = mod.modResults.contents.replace(unversionedPlugin, versionedPlugin);
    return mod;
  });

  return withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    const replacements = new Set((application.$['tools:replace'] || '').split(',').filter(Boolean));
    // AppsFlyer 7 declares its own backup XML in the library manifest. Keep
    // the app's explicit SecureStore exclusions for credentials after restore.
    for (const attribute of ['android:fullBackupContent', 'android:dataExtractionRules']) {
      if (application.$[attribute]) replacements.add(attribute);
    }
    if (replacements.size) {
      mod.modResults.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
      application.$['tools:replace'] = [...replacements].join(',');
    }
    return mod;
  });
};
