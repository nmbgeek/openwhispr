import { buildLocalWhisperPrompt } from '../localWhisperPrompt';

let mockPersonal = ['Piha', 'Biscuit'];
let mockTriggers = ['sig'];
let mockSpace = ['SpaceWord'];
let mockWorkspace: string[] = [];
jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: {
    getState: () => ({ isLoaded: true, entries: mockPersonal.map((word) => ({ word })) }),
  },
}));
jest.mock('@/store/useSharedDictionaryStore', () => ({
  useSharedDictionaryStore: {
    getState: () => ({
      hints: { space: mockSpace, workspace: mockWorkspace },
      hiddenOnlyKeys: new Set(),
    }),
  },
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: {
    getState: () => ({ isLoaded: true, entries: mockTriggers.map((trigger) => ({ trigger })) }),
  },
}));

beforeEach(() => {
  mockPersonal = ['Piha', 'Biscuit'];
  mockTriggers = ['sig'];
  mockSpace = ['SpaceWord'];
  mockWorkspace = Array.from({ length: 300 }, (_, i) => `Workspace${i}`);
});

test('dictation uses bounded shared hints and keeps personal words and snippet triggers at the tail', () => {
  const prompt = buildLocalWhisperPrompt('recording');
  expect(prompt?.endsWith('SpaceWord, Piha, Biscuit, sig')).toBe(true);
  expect(prompt?.length).toBeLessThanOrEqual(550);
  expect(buildLocalWhisperPrompt('keyboard')).toBe(prompt);
});

test('file and unspecified contexts keep dictionaries but exclude dictation-only snippet triggers', () => {
  expect(buildLocalWhisperPrompt('file')?.endsWith('SpaceWord, Piha, Biscuit')).toBe(true);
  expect(buildLocalWhisperPrompt('file')).not.toContain('sig');
  expect(buildLocalWhisperPrompt(undefined)).toBe(buildLocalWhisperPrompt('file'));
});

test('personal hints retain the existing no-truncation behavior even beyond the ordinary budget', () => {
  const longPersonal = 'PersonalName'.repeat(100);
  mockPersonal = [longPersonal];
  mockTriggers = [];
  expect(buildLocalWhisperPrompt('recording')).toBe(longPersonal);
});

test('empty dictionaries and snippets produce no initial prompt', () => {
  mockPersonal = [];
  mockTriggers = [];
  mockSpace = [];
  mockWorkspace = [];
  expect(buildLocalWhisperPrompt('recording')).toBeUndefined();
});
