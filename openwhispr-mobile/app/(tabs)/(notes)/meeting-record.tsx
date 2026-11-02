import { Platform } from 'react-native';
import { Redirect } from 'expo-router';
import { MeetingRecordScreen } from '@/screens/MeetingRecordScreen';

export default function MeetingRecordRoute() {
  return Platform.OS === 'ios' ? <MeetingRecordScreen /> : <Redirect href="/(tabs)/(notes)" />;
}
