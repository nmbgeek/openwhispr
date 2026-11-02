import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { AndroidMeetingRecordScreen } from '../AndroidMeetingRecordScreen';

const mockState = {
  createMeetingNote: jest.fn(),
  updateNote: jest.fn(),
  getNoteById: jest.fn(),
  transitionStatus: jest.fn(),
  retainMeetingRecording: jest.fn(),
  runMeetingPipeline: jest.fn(),
};
let mockFinished: ((error: Error | null) => void) | undefined;
let mockRecordingOptions: Record<string, unknown>;
const mockRecorder = {
  startRecording: jest.fn(),
  stopRecordingRaw: jest.fn(),
  cancelRecording: jest.fn(),
  isRecording: true,
  audioRecorder: { isRecording: true },
};
const mockWaitActive = jest.fn();
const mockReadiness = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ folderId: '3' }),
}));
jest.mock('@react-navigation/native', () => ({ usePreventRemove: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({
  Button: ({ children, ...props }: { children: React.ReactNode }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable {...props}>
        <Text>{children}</Text>
      </Pressable>
    );
  },
}));
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: (options: Record<string, unknown>) => {
    mockRecordingOptions = options;
    mockFinished = options.onRecordingFinished as typeof mockFinished;
    return mockRecorder;
  },
}));
jest.mock('@/lib/inferenceRouting', () => ({ getPickedLocalModel: () => 'mlkit-basic' }));
jest.mock('@/lib/localSpeechModels', () => ({ mlKitLocale: () => 'fr-FR' }));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: (...args: unknown[]) => mockReadiness(...args),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'fr' }));
jest.mock('@/lib/meetingRecovery', () => ({
  waitForAppActive: (...args: unknown[]) => mockWaitActive(...args),
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: { preferredEngineDescriptor: () => ({ label: 'ML Kit Basic' }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: {} }) },
}));
jest.mock('@/store/useNotesStore', () => ({ useNotesStore: { getState: () => mockState } }));

beforeEach(() => {
  jest.clearAllMocks();
  mockRecorder.isRecording = true;
  mockRecorder.audioRecorder.isRecording = true;
  mockRecorder.startRecording.mockResolvedValue(undefined);
  mockRecorder.stopRecordingRaw.mockResolvedValue('file:///cache/capture.m4a');
  mockReadiness.mockResolvedValue({ status: 'ready' });
  mockWaitActive.mockResolvedValue(undefined);
  mockState.createMeetingNote.mockReturnValue({ id: 7 });
  mockState.getNoteById.mockReturnValue({ id: 7, transcriptionStatus: 'recording' });
  mockState.retainMeetingRecording.mockResolvedValue('file:///docs/meeting-7.m4a');
  mockState.runMeetingPipeline.mockResolvedValue(undefined);
});

async function start(view: ReturnType<typeof render>) {
  fireEvent.press(view.getByTestId('android-meeting-start'));
  await waitFor(() => expect(view.getByTestId('android-meeting-stop')).toBeTruthy());
}

it('records in background privately, saves typed notes, and pins local speech routing', async () => {
  const view = render(<AndroidMeetingRecordScreen />);
  await start(view);
  expect(mockRecordingOptions).toEqual(
    expect.objectContaining({
      allowsBackgroundRecording: true,
      liveTranscription: false,
      saveToHistory: false,
    }),
  );
  expect(mockState.createMeetingNote).toHaveBeenCalledWith(
    expect.objectContaining({ isPrivate: true, diarizationEnabled: false, folderId: 3 }),
  );
  fireEvent.changeText(view.getByTestId('android-meeting-notes'), 'Decision: ship Friday');
  fireEvent.press(view.getByTestId('android-meeting-stop'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/(notes)/7'));
  expect(mockState.updateNote).toHaveBeenCalledWith(7, { content: 'Decision: ship Friday' });
  expect(mockState.runMeetingPipeline).toHaveBeenCalledWith(
    7,
    'file:///docs/meeting-7.m4a',
    undefined,
    expect.objectContaining({ model: 'mlkit-basic', language: 'fr', locale: 'fr-FR' }),
  );
  view.unmount();
});

it('claims finish synchronously when notification Stop races manual Stop', async () => {
  let resolveStop!: (uri: string) => void;
  mockRecorder.stopRecordingRaw.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveStop = resolve;
      }),
  );
  const view = render(<AndroidMeetingRecordScreen />);
  await start(view);
  fireEvent.press(view.getByTestId('android-meeting-stop'));
  act(() => mockFinished?.(null));
  await act(async () => {
    resolveStop('file:///cache/capture.m4a');
  });
  await waitFor(() => expect(mockState.runMeetingPipeline).toHaveBeenCalledTimes(1));
  expect(mockRecorder.stopRecordingRaw).toHaveBeenCalledTimes(1);
  expect(mockState.retainMeetingRecording).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('retains notification Stop audio immediately and waits for foreground before local inference', async () => {
  let resume!: () => void;
  mockWaitActive.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  const view = render(<AndroidMeetingRecordScreen />);
  await start(view);
  mockRecorder.isRecording = false;
  act(() => mockFinished?.(null));
  await waitFor(() =>
    expect(mockState.retainMeetingRecording).toHaveBeenCalledWith(
      7,
      'file:///cache/capture.m4a',
      undefined,
    ),
  );
  expect(mockState.runMeetingPipeline).not.toHaveBeenCalled();
  await act(async () => resume());
  await waitFor(() => expect(mockState.runMeetingPipeline).toHaveBeenCalledTimes(1));
  view.unmount();
});

it('retains partial capture after native error without treating it as completed speech', async () => {
  const view = render(<AndroidMeetingRecordScreen />);
  await start(view);
  act(() => mockFinished?.(new Error('Microphone interrupted')));
  await waitFor(() => expect(view.getByText('Microphone interrupted')).toBeTruthy());
  expect(mockState.retainMeetingRecording).toHaveBeenCalledTimes(1);
  expect(mockState.transitionStatus).toHaveBeenCalledWith(7, 'failed');
  expect(mockState.runMeetingPipeline).not.toHaveBeenCalled();
  view.unmount();
});

it('does not create a phantom note if recorder startup was interrupted', async () => {
  mockRecorder.audioRecorder.isRecording = false;
  const view = render(<AndroidMeetingRecordScreen />);
  fireEvent.press(view.getByTestId('android-meeting-start'));
  await waitFor(() => expect(view.getByText(/Recording did not start/)).toBeTruthy());
  expect(mockState.createMeetingNote).not.toHaveBeenCalled();
  view.unmount();
});
