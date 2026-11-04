// Meet UI selectors in ONE file — update here when Google changes the UI.
// Handles guest + signed-in variants; screenshot on failure (debug dir).
export const SEL = {
  nameField: 'input[aria-label*="name" i], input[placeholder*="name" i]',
  // Precise on purpose: a bare has-text("Join") also matches "Other ways to
  // join", and clicking that just expands a menu (looked like a Join timeout).
  joinButton: 'button:has-text("Join now"), button:has-text("Ask to join"), button:has-text("Switch here")',
  micOff: 'button[aria-label*="microphone" i]',
  camOff: 'button[aria-label*="camera" i]',
  dismiss: 'button:has-text("Dismiss"), button:has-text("Got it"), button:has-text("Continue without")',
  peopleCount: '[aria-label*="participant" i], [aria-label*="People" i]',
  chatButton: 'button[aria-label*="chat" i]',
};
export const DEBUG_DIR = process.env.COACH_BOT_DEBUG_DIR || "/tmp/opencode/coach-bot-debug";
