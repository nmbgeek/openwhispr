import { Platform } from 'react-native';
import { MeetingRecordScreen } from '@/screens/MeetingRecordScreen';
import { AndroidMeetingRecordScreen } from '@/screens/AndroidMeetingRecordScreen';

export default function MeetingRecordRoute() {
  return Platform.OS === 'android' ? <AndroidMeetingRecordScreen /> : <MeetingRecordScreen />;
}
