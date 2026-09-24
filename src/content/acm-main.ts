import { createCodeEditor } from '../platforms/nowcoder/code-editor';

// MAIN-world bridge has no credentials, network client or extension messages.
// Repeated injection must preserve the editor ticket while the model is running.
globalThis.AutofferAcm ??= createCodeEditor(
  document,
  undefined,
  undefined,
  () =>
    document
      .getElementById('autoffer-page-tools')
      ?.getAttribute('data-running') === 'true',
);
declare global {
  var AutofferAcm: ReturnType<typeof createCodeEditor> | undefined;
}
