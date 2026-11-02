import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { Platform } from 'react-native';
import { displayFontFamily } from '@/lib/fonts';
import { APP_BACKGROUND } from '@/config/colors';

export const glassStackOptions: NativeStackNavigationOptions = {
  // Android does not apply iOS automatic ScrollView insets beneath a transparent
  // native header. Keep the bar in normal layout so settings begin below it.
  ...(Platform.OS === 'ios'
    ? ({
        headerTransparent: true,
        headerLargeTitle: true,
        headerBlurEffect: 'systemMaterial',
        headerLargeStyle: { backgroundColor: 'transparent' },
      } satisfies NativeStackNavigationOptions)
    : {
        headerTransparent: false,
        headerLargeTitle: false,
        headerStyle: { backgroundColor: APP_BACKGROUND },
      }),
  // Without Yowza the family is undefined and titles stay in the system font.
  headerTitleStyle: { fontFamily: displayFontFamily },
  headerLargeTitleStyle: { fontFamily: displayFontFamily },
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
};

/**
 * For screens that draw their own header with `TabScreenHeader` instead of the
 * native bar.
 *
 * iOS 26 gives every content ScrollView an automatic scroll edge effect, which
 * blurs content under the navigation area. With no native bar above it that
 * reads as an unexplained lighter band with a divider, so the header and the
 * body stop looking like one surface. Hiding it also resolves react-native-
 * screens' `blurEffect` + `scrollEdgeEffects` overlap warning.
 */
export const customHeaderStackOptions: NativeStackNavigationOptions = {
  headerShown: false,
  scrollEdgeEffects: { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' },
};
