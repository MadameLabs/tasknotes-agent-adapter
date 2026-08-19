export function parseHookPayload(agent, event, input) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id.trim() : "";
  if (!sessionId) throw new Error("missing_session_id");
  if (agent !== "claude" && agent !== "codex") throw new Error("invalid_agent");
  return {
    sessionKey: `${agent}:${sessionId}`,
    sessionId,
    event,
    cwd: input.cwd,
  };
}
