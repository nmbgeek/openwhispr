import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AndroidSpeech, type AndroidSpeechStatus } from '../../../modules/android-speech/src';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { useConfigStore } from '@/store/useConfigStore';
import { pickLocalModel, switchWorkflowMode } from '@/lib/workflowModeSwitch';
import { ML_KIT_TITLES, mlKitLocale, mlKitMode, type MlKitModelKey } from '@/lib/localSpeechModels';

const MODELS: readonly MlKitModelKey[] = ['mlkit-basic', 'mlkit-advanced'];

export function AndroidSpeechModels({
  scope,
  picked,
}: {
  scope: 'dictation' | 'upload';
  picked?: string;
}): React.JSX.Element | null {
  const config = useConfigStore((state) => state.config);
  const locale = mlKitLocale(config);
  const [statuses, setStatuses] = useState<Partial<Record<MlKitModelKey, AndroidSpeechStatus>>>({});
  const [busy, setBusy] = useState<MlKitModelKey | null>(null);
  const [downloading, setDownloading] = useState(false);
  const operation = useRef(false);
  const focused = useRef(false);
  const focusGeneration = useRef(0);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      focused.current = true;
      focusGeneration.current += 1;
      let cancelled = false;
      setStatuses({});
      const check = (): void => {
        if (!locale) return;
        Promise.all(
          MODELS.map(async (model) => {
            try {
              return await AndroidSpeech.getStatus(mlKitMode(model), locale);
            } catch {
              return {
                status: 'unavailable',
                reason: 'Unable to check support. Try again later.',
              } satisfies AndroidSpeechStatus;
            }
          }),
        ).then(([basic, advanced]) => {
          if (!cancelled) setStatuses({ 'mlkit-basic': basic, 'mlkit-advanced': advanced });
        });
      };
      check();
      const appState = AppState.addEventListener('change', (state) => {
        if (state === 'active') check();
      });
      // AICore may finish preparing a model outside this app.
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') check();
      }, 10000);
      return (): void => {
        cancelled = true;
        focused.current = false;
        focusGeneration.current += 1;
        appState.remove();
        clearInterval(timer);
      };
    }, [locale]),
  );

  if (Platform.OS !== 'android') return null;

  async function choose(model: MlKitModelKey): Promise<void> {
    if (!locale || operation.current) return;
    operation.current = true;
    const generation = focusGeneration.current;
    const startingSelection = useConfigStore.getState().config?.inference?.[scope];
    const stillFocused = (): boolean => focused.current && focusGeneration.current === generation;
    const unchanged = (): boolean =>
      stillFocused() &&
      useConfigStore.getState().config?.inference?.[scope] === startingSelection &&
      mlKitLocale(useConfigStore.getState().config) === locale;
    setBusy(model);
    try {
      const mode = mlKitMode(model);
      let status = await AndroidSpeech.getStatus(mode, locale);
      if (!unchanged()) return;
      if (status.status === 'downloadable') {
        setDownloading(true);
        await AndroidSpeech.download(mode, locale);
        status = await AndroidSpeech.getStatus(mode, locale);
      }
      if (!unchanged()) return;
      setStatuses((current) => ({ ...current, [model]: status }));
      if (status.status !== 'available')
        throw new Error(
          status.reason || 'The model is not ready. Check again after its download finishes.',
        );
      if (mlKitLocale(useConfigStore.getState().config) !== locale) return;
      await pickLocalModel(scope, model);
      if (useConfigStore.getState().error)
        throw new Error('Unable to save this model. Please try again.');
      await switchWorkflowMode(
        scope,
        'local',
        () =>
          stillFocused() &&
          useConfigStore.getState().config?.inference?.[scope]?.mode === 'local' &&
          useConfigStore.getState().config?.inference?.[scope]?.modelId === model,
      );
    } catch (error: unknown) {
      if (!stillFocused() || (error instanceof Error && error.name === 'AbortError')) return;
      Alert.alert(
        'On-device speech',
        error instanceof Error
          ? error.message
          : 'Unable to prepare the speech model. Please try again.',
      );
    } finally {
      operation.current = false;
      setBusy(null);
      setDownloading(false);
    }
  }

  return (
    <SettingsSection title="Optional ML Kit speech">
      {MODELS.map((model) => {
        const status = statuses[model];
        const ready = status?.status === 'available';
        const downloadable = status?.status === 'downloadable';
        const selected = picked === model;
        const description = !locale
          ? 'Choose one transcription language to check support. Use Whisper for auto-detect or multiple languages.'
          : `${locale} · ${model === 'mlkit-basic' ? 'Traditional on-device speech, Android 12 or later.' : 'On-device Gemini speech on supported devices.'} Live text while recording. ${status?.reason ?? ''}`;
        const label = !locale
          ? 'Choose language'
          : !status
            ? 'Checking…'
            : ready
              ? 'Ready'
              : downloadable
                ? 'Download & use'
                : status.status === 'downloading'
                  ? 'Downloading'
                  : 'Not supported';
        return (
          <SettingsRow
            key={model}
            icon={selected ? 'checkmark.circle.fill' : 'waveform'}
            mdIcon={selected ? 'CircleCheck' : 'AudioLines'}
            iconStyle="line"
            title={ML_KIT_TITLES[model]}
            description={description}
            subtitle={label}
            selected={selected}
            showChevron={false}
            disabled={busy !== null || (!ready && !downloadable)}
            rightElement={busy === model ? <ActivityIndicator /> : undefined}
            onPress={() => {
              void choose(model);
            }}
          />
        );
      })}
      {downloading ? (
        <SettingsRow
          icon="xmark.circle"
          mdIcon="CircleX"
          iconStyle="line"
          title="Cancel model preparation"
          description="Google services may continue a shared download."
          showChevron={false}
          onPress={() => {
            AndroidSpeech.cancel().catch(() => {
              Alert.alert(
                'On-device speech',
                'Unable to cancel model preparation. Please try again.',
              );
            });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
