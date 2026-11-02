const { spawnSync } = require('node:child_process');

// Android EAS workers do not have Bundler or need CocoaPods dependencies.
if (process.env.EAS_BUILD_PLATFORM === 'ios') {
  const result = spawnSync('bundle', ['install'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
