import extractor from './extractor';
import {
  assertQuestionPage,
  selectAndAdvance,
  advanceWithoutAnswer,
  advanceSection,
} from './actions';
import type { PlatformAdapter } from '../types';

export default {
  ...extractor,
  actions: {
    nextSection: advanceSection,
    answerKinds: ['single', 'multiple'],
    assertReady: assertQuestionPage,
    apply: selectAndAdvance,
    skip: advanceWithoutAnswer,
  },
} satisfies PlatformAdapter;
