/** Recognize the exact extension UI document before considering content-script access. */
export function isTrustedUiSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
  panelUrl: string,
): boolean {
  return (
    sender.id === extensionId &&
    sender.url === panelUrl &&
    (sender.frameId === undefined || sender.frameId === 0)
  );
}
