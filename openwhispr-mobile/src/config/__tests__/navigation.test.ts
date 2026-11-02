let mockOS = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOS;
    },
  },
}));
jest.mock('@/lib/fonts', () => ({ displayFontFamily: 'Display Font' }));
jest.mock('@/config/colors', () => ({ APP_BACKGROUND: '#F8F6F5' }));

beforeEach(() => {
  jest.resetModules();
});

test('Android settings use an opaque native header in normal layout', () => {
  mockOS = 'android';
  const { glassStackOptions }: typeof import('../navigation') = require('../navigation');
  expect(glassStackOptions).toMatchObject({
    headerTransparent: false,
    headerLargeTitle: false,
    headerStyle: { backgroundColor: '#F8F6F5' },
  });
  expect(glassStackOptions.headerBlurEffect).toBeUndefined();
});

test('iOS retains its transparent large-title glass header', () => {
  mockOS = 'ios';
  const { glassStackOptions }: typeof import('../navigation') = require('../navigation');
  expect(glassStackOptions).toMatchObject({
    headerTransparent: true,
    headerLargeTitle: true,
    headerBlurEffect: 'systemMaterial',
    headerLargeStyle: { backgroundColor: 'transparent' },
    headerTitleStyle: { fontFamily: 'Display Font' },
  });
});
