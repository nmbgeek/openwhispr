import React, { useCallback, useState } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AndroidSpeech } from '../../../modules/android-speech/src';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';

export function AndroidSystemSettings(): React.JSX.Element | null {
  const [exempt, setExempt] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !AndroidSpeech.isAvailable()) return undefined;
      let cancelled = false;
      const check = (): void => {
        AndroidSpeech.isBatteryOptimizationExempt()
          .then((value) => {
            if (!cancelled) {
              setExempt(value);
              setFailed(false);
            }
          })
          .catch(() => {
            if (!cancelled) {
              setExempt(null);
              setFailed(true);
            }
          });
      };
      check();
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') check();
      });
      return (): void => {
        cancelled = true;
        subscription.remove();
      };
    }, []),
  );
  if (Platform.OS !== 'android') return null;

  return (
    <SettingsSection title="Android system settings">
      <SettingsRow
        icon="battery.100percent"
        mdIcon="Battery"
        iconStyle="line"
        title="Battery optimization exemption"
        subtitle={
          exempt === true
            ? 'Exempt'
            : exempt === false
              ? 'Optimized'
              : failed
                ? 'Status unavailable'
                : 'Checking…'
        }
        description="Battery optimization can interrupt long recordings and background work. In system settings, select OpenWhispr and allow unrestricted battery use if needed. This is optional and may increase battery use."
        disabled={!AndroidSpeech.isAvailable()}
        onPress={() => {
          AndroidSpeech.openBatteryOptimizationSettings().catch(() => {
            Alert.alert(
              'System settings',
              'Unable to open battery settings. Open Android Settings, select Apps, OpenWhispr, then Battery.',
            );
          });
        }}
      />
    </SettingsSection>
  );
}
