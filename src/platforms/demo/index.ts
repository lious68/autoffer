import { defineTemplate } from '../template';

export default defineTemplate({
  meta: {
    id: 'demo',
    name: 'AutOffer 演示平台',
    version: '1.0.0',
    status: 'demo',
  },
  match: {
    hosts: ['localhost', '127.0.0.1'],
    pathPrefix: '/demo.html',
    marker: '[data-autoffer-demo="v1"]',
  },
  rules: [
    {
      root: '[data-kind="single"]',
      classification: {
        domain: 'aptitude',
        format: 'single-choice',
        intent: 'knowledge',
      },
      stem: '[data-stem]',
      material: '[data-material]',
      options: {
        root: '[data-option]',
        text: '[data-text]',
        label: '[data-label]',
      },
    },
    {
      root: '[data-kind="multiple"]',
      classification: {
        domain: 'aptitude',
        format: 'multiple-choice',
        intent: 'knowledge',
      },
      stem: '[data-stem]',
      sharedMaterial: '#shared-material',
      options: {
        root: '[data-option]',
        text: '[data-text]',
        label: '[data-label]',
      },
    },
    {
      root: '[data-kind="personal"]',
      classification: {
        domain: 'psychological',
        format: 'single-choice',
        intent: 'self-report',
      },
      stem: '[data-stem]',
      options: { root: '[data-option]', text: '[data-text]' },
    },
    {
      root: '[data-kind="text"]',
      classification: {
        domain: 'unknown',
        format: 'subjective',
        intent: 'knowledge',
      },
      stem: '[data-stem]',
    },
  ],
});
