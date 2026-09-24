import type { PlatformAdapter } from '../types';
import extractor, { entries } from './extractor';
import { apply, assertReady, select, skip } from './actions';

export default {
  ...extractor,
  navigation: {
    list: (context) =>
      entries(context).map(({ question }, index) => ({
        id: question.id,
        label: `${index + 1}. ${question.stem.replace(/^\d+\s*[、.．]\s*/, '').slice(0, 65)}`,
      })),
    select,
  },
  actions: { answerKinds: ['single', 'multiple'], assertReady, apply, skip },
} satisfies PlatformAdapter;
