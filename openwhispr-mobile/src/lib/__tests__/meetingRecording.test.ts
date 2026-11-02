jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  getInfoAsync: jest.fn(),
  moveAsync: jest.fn(),
}));
import * as FileSystem from 'expo-file-system/legacy';
import { retainMeetingRecording } from '../meetingRecording';

beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 512 });
  (FileSystem.moveAsync as jest.Mock).mockResolvedValue(undefined);
});

it('adopts M4A with its actual extension and moves ownership once', async () => {
  expect(await retainMeetingRecording(7, 'file:///cache/recording.m4a')).toBe(
    'file:///docs/meeting-7.m4a',
  );
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({
    from: 'file:///cache/recording.m4a',
    to: 'file:///docs/meeting-7.m4a',
  });
  await retainMeetingRecording(7, 'file:///docs/meeting-7.m4a');
  expect(FileSystem.moveAsync).toHaveBeenCalledTimes(1);
});

it('recovers a completed move if metadata persistence failed', async () => {
  (FileSystem.getInfoAsync as jest.Mock)
    .mockResolvedValueOnce({ exists: false })
    .mockResolvedValueOnce({ exists: true, size: 512 });
  expect(await retainMeetingRecording(7, 'file:///cache/recording.m4a')).toBe(
    'file:///docs/meeting-7.m4a',
  );
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
});

it('surfaces move failures without deleting the original', async () => {
  (FileSystem.moveAsync as jest.Mock).mockRejectedValue(new Error('disk unavailable'));
  await expect(retainMeetingRecording(7, 'file:///cache/recording.m4a')).rejects.toThrow(
    'disk unavailable',
  );
});

it('rejects empty and unsupported audio before adoption', async () => {
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 0 });
  await expect(retainMeetingRecording(7, 'file:///cache/recording.m4a')).rejects.toThrow('empty');
  await expect(retainMeetingRecording(7, 'file:///cache/recording.mp3')).rejects.toThrow('format');
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
});
