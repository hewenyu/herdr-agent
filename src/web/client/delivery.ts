/** The browser must render a reply before the server records it as user-visible. */
export async function displayThenAcknowledge(
  display: () => void,
  acknowledge: () => Promise<void>,
  unconfirmed: () => void,
): Promise<boolean> {
  display();
  try {
    await acknowledge();
    return true;
  } catch {
    unconfirmed();
    return false;
  }
}
