import * as FileSystem from 'expo-file-system/legacy';

/** Adopt a stopped Expo recording without copying M4A bytes into a misleading WAV path. */
export async function retainMeetingRecording(noteId: number, sourceUri: string): Promise<string> {
  if (!FileSystem.documentDirectory) throw new Error('Meeting storage is unavailable.');
  const extension = sourceUri.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (extension !== 'm4a' && extension !== 'wav')
    throw new Error('The meeting recording format is not supported.');
  const destination = `${FileSystem.documentDirectory}meeting-${noteId}.${extension}`;
  const source = await FileSystem.getInfoAsync(sourceUri);
  if (!source.exists) {
    // A rename may have completed before its note metadata write failed.
    const adopted = await FileSystem.getInfoAsync(destination);
    if (adopted.exists && adopted.size > 0) return destination;
    throw new Error('The meeting recording file is unavailable.');
  }
  if (source.size === 0) throw new Error('The meeting recording is empty.');
  if (sourceUri !== destination) await FileSystem.moveAsync({ from: sourceUri, to: destination });
  return destination;
}
