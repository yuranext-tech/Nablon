// userResponse.js
// Boundary handler for user responses.
//
// Important architectural rule:
// Nablon records what happened; it does not decide what the response means.
// Interpretation belongs downstream (Becoming / later analysis).

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC');
}

function buildUserResponse(ctx, episode, prompt, receivedAt = new Date()) {
  const message = ctx?.message;
  const text = normalizeText(message?.text);

  return {
    responseId: `resp_${message?.message_id ?? 'unknown'}_${receivedAt.getTime()}`,
    telegramMessageId: message?.message_id ?? null,
    telegramUpdateId: ctx?.update?.update_id ?? null,
    receivedAt: receivedAt.toISOString(),
    userTelegramId: ctx?.from?.id ?? null,
    chatId: message?.chat?.id ?? null,

    // Episode context is copied at capture time so the raw record remains
    // interpretable even if the training definition changes later.
    episodeId: episode?.id ?? null,
    sessionId: episode?.session_id ?? null,
    sceneId: episode?.scene_id ?? null,
    turnIndex: episode?.turn_index ?? null,
    prompt: typeof prompt === 'string' ? prompt : null,

    // Raw user material. Never replace this with an LLM summary.
    text,
    textLength: [...text].length,

    // Transport-level facts only. These are signals, not conclusions.
    hasText: text.length > 0,
    isReply: Boolean(message?.reply_to_message),
    replyToMessageId: message?.reply_to_message?.message_id ?? null,
  };
}

module.exports = { buildUserResponse, normalizeText };
