# Standalone adaptive set v0.1

Run from repository root: `node adaptive/test.js` (Node.js 18+). No external services or dependencies.

The engine is an in-memory, JSON-serializable domain prototype; it is not connected to the bot, storage, or any transport. Caller owns durable persistence and delivery confirmation. For a restart, serialize the state and use `restore(serialized)` before resuming; this is demonstrated in the tests. Confirm scenario and each non-terminal consequence via `presentation` before attributing independent responses. Unknown delivery leaves the level offer as a user choice. Outcome facts and observational markers are not personal assessments.

Actions: S1 `add/view`; S2 `copy/settings`; S3 `copy/check/delete`; S4A `open/calendar/send12/send14`; S4B `review/send12/send14`; S5 `wait/check/allow/message`. Call `help` and then `presentation(state, 'help', 'confirmed'|'unknown')` when appropriate. Stop and resume preserve the current turn. The engine accepts only one help request per episode in this prototype.
