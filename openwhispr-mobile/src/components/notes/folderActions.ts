import { ActionSheetIOS, Alert, Platform } from 'react-native';

export function showFolderActions({
  canDelete,
  onRename,
  onDelete,
}: {
  canDelete: boolean;
  onRename: () => void;
  onDelete: () => void;
}): void {
  if (Platform.OS !== 'ios') {
    Alert.alert('Folder actions', undefined, [
      { text: 'Rename', onPress: onRename },
      ...(canDelete ? [{ text: 'Delete', style: 'destructive' as const, onPress: onDelete }] : []),
      { text: 'Cancel', style: 'cancel' },
    ]);
    return;
  }
  const options = canDelete ? ['Rename', 'Delete', 'Cancel'] : ['Rename', 'Cancel'];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options,
      cancelButtonIndex: options.length - 1,
      destructiveButtonIndex: canDelete ? 1 : undefined,
    },
    (index) => {
      if (index === 0) onRename();
      else if (canDelete && index === 1) onDelete();
    },
  );
}
