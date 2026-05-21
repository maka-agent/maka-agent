# Maka Desktop Smoke Gate

Run these checks before cutting a release build. They cover the current V0.1 maturity baselines: model onboarding, credential lifecycle, streaming UI, cross-window session consistency, and destructive permission UX.

## 1. First Launch Without A Model

Setup: start with a fresh user data directory or remove saved Maka settings/connections.

Expected:
- Empty chat shows the onboarding hero with provider cards.
- It does not show the generic empty chat prompt.
- Sending without a real provider opens Settings -> Models and keeps the composer input.

## 2. Add And Test A Connection

Steps:
- Open Settings -> Models.
- Add an Anthropic connection with an API key and save it.
- Open Settings -> Account.
- Confirm the connection row shows configured but not verified.
- Click Test connection.

Expected:
- The row updates to verified after a successful test.
- The row shows the test model and latency.
- The default connection row has the default badge.
- No secret value is shown in the row, toast, or logs.

## 3. Failed Credential Status In Chat Header

Steps:
- Change the saved API key to an invalid value.
- Run Test connection.
- Return to the chat view.

Expected:
- Settings -> Account shows an error state with a generalized message.
- The chat header shows the connection failure pill.
- Clicking the pill opens Settings -> Account.
- The connection remains enabled; a failed test does not disable it.

## 4. Streaming And Active Session Deletion

Steps:
- Send a message that starts a streaming turn.
- Confirm the composer switches to the streaming state.
- In another window, or with an IPC-level test/mock, emit `sessions:changed` with `{ reason: 'deleted', sessionId: activeId }` for the active session.

Expected:
- The composer shows Stop while streaming and hides Send.
- Escape stops the active stream; it does not interfere when no stream is active.
- After the active session delete event, the renderer clears active session state, messages, live tool state, and pending permission state.
- The app does not crash or keep sending to the deleted session.

## 5. Destructive Permission Dialog

Setup: simulate or intercept a permission request for a destructive filesystem action such as `rm -rf`. Do not execute the command.

Expected:
- The permission dialog uses destructive styling.
- The reason label is localized as an irreversible filesystem operation.
- The dialog shows the extra irreversible-operation warning below the remember-for-turn checkbox.
- The allow button uses the explicit destructive confirmation label.
- The remember-for-turn text states it expires after closing or switching conversations.
