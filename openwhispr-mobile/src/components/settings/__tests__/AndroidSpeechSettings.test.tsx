import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native');
  rn.Platform.OS = 'android';
  return rn;
});
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
const mockConfig: { preferredLanguage: string; inference?: { upload?: { mode: string } } } = {
  preferredLanguage: 'en-US',
};
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ config: mockConfig }),
    {
      getState: () => ({ config: mockConfig, error: null }),
    },
  ),
}));
const mockPick = jest.fn(async () => undefined);
const mockSwitch = jest.fn(async () => 'switched');
jest.mock('@/lib/workflowModeSwitch', () => ({
  pickLocalModel: (...args: unknown[]) => mockPick(...(args as [])),
  switchWorkflowMode: (...args: unknown[]) => mockSwitch(...(args as [])),
}));
jest.mock('../../../../modules/android-speech/src', () => ({
  AndroidSpeech: {
    isAvailable: () => true,
    getStatus: jest.fn(async (mode: string) => ({
      status: mode === 'basic' ? 'downloadable' : 'unavailable',
    })),
    download: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    isBatteryOptimizationExempt: jest.fn(async () => false),
    openBatteryOptimizationSettings: jest.fn(async () => undefined),
  },
}));

import { AndroidSpeech } from '../../../../modules/android-speech/src';
import { AndroidSpeechModels } from '../AndroidSpeechModels';
import { AndroidSystemSettings } from '../AndroidSystemSettings';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }));
  mockConfig.preferredLanguage = 'en-US';
  delete mockConfig.inference;
  jest.mocked(AndroidSpeech.download).mockReset().mockResolvedValue(undefined);
  jest.mocked(AndroidSpeech.getStatus).mockImplementation(async (mode) => ({
    status: mode === 'basic' ? 'downloadable' : 'unavailable',
  }));
  jest.mocked(AndroidSpeech.isBatteryOptimizationExempt).mockResolvedValue(false);
});

test('ML Kit checks support without downloading until the user taps; then saves the correct workflow', async () => {
  render(<AndroidSpeechModels scope="upload" />);
  await screen.findByText('Download & use');
  expect(AndroidSpeech.download).not.toHaveBeenCalled();
  expect(mockPick).not.toHaveBeenCalled();
  jest
    .mocked(AndroidSpeech.getStatus)
    .mockResolvedValueOnce({ status: 'downloadable' })
    .mockResolvedValueOnce({ status: 'available' });
  fireEvent.press(screen.getByText('ML Kit Basic'));
  await waitFor(() => expect(mockPick).toHaveBeenCalledWith('upload', 'mlkit-basic'));
  expect(AndroidSpeech.download).toHaveBeenCalledWith('basic', 'en-US');
  expect(mockSwitch).toHaveBeenCalledWith('upload', 'local', expect.any(Function));
});

test('unsupported Advanced remains visible and cannot be selected', async () => {
  render(<AndroidSpeechModels scope="dictation" />);
  await screen.findByText('Not supported');
  fireEvent.press(screen.getByText('ML Kit Advanced'));
  expect(mockPick).not.toHaveBeenCalled();
  expect(AndroidSpeech.download).not.toHaveBeenCalled();
});

test('auto-detect does not probe or download guessed-language models', () => {
  mockConfig.preferredLanguage = 'auto';
  render(<AndroidSpeechModels scope="dictation" />);
  expect(screen.getAllByText('Choose language')).toHaveLength(2);
  expect(AndroidSpeech.getStatus).not.toHaveBeenCalled();
  expect(AndroidSpeech.download).not.toHaveBeenCalled();
});

test('battery exemption opens only on tap and refreshes actual system status on return', async () => {
  const listener = jest.spyOn(AppState, 'addEventListener');
  render(<AndroidSystemSettings />);
  await screen.findByText('Optimized');
  expect(AndroidSpeech.openBatteryOptimizationSettings).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Battery optimization exemption'));
  expect(AndroidSpeech.openBatteryOptimizationSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Optimized')).toBeTruthy();
  jest.mocked(AndroidSpeech.isBatteryOptimizationExempt).mockResolvedValue(true);
  const callback = listener.mock.calls.find(([event]) => event === 'change')?.[1];
  await act(async () => {
    callback?.('active');
  });
  expect(await screen.findByText('Exempt')).toBeTruthy();
  listener.mockRestore();
});

test('leaving during a download cannot activate a stale workflow selection', async () => {
  let complete: (() => void) | undefined;
  jest.mocked(AndroidSpeech.download).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const view = render(<AndroidSpeechModels scope="upload" />);
  await screen.findByText('Download & use');
  fireEvent.press(screen.getByText('ML Kit Basic'));
  await screen.findByText('Cancel model preparation');
  view.unmount();
  await act(async () => {
    complete?.();
  });
  expect(mockPick).not.toHaveBeenCalled();
  expect(mockSwitch).not.toHaveBeenCalled();
});

test('a newer Cloud selection wins over a pending model download', async () => {
  let complete: (() => void) | undefined;
  jest.mocked(AndroidSpeech.download).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  render(<AndroidSpeechModels scope="upload" />);
  await screen.findByText('Download & use');
  fireEvent.press(screen.getByText('ML Kit Basic'));
  await screen.findByText('Cancel model preparation');
  mockConfig.inference = { upload: { mode: 'openwhispr' } };
  await act(async () => {
    complete?.();
  });
  expect(mockPick).not.toHaveBeenCalled();
  expect(mockSwitch).not.toHaveBeenCalled();
});
