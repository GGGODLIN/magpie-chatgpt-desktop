import { describe, expect, test } from "bun:test";
import { checkDailyBudget, extractFinalAnswer, rewriteConversationBody } from "../src/web.js";

const pageBody = () => ({
  action: "next",
  model: "gpt-6-thinking",
  history_and_training_disabled: true,
  messages: [{ id: "m1", author: { role: "user" }, content: { content_type: "text", parts: ["."] } }],
});

describe("rewriteConversationBody", () => {
  test("swaps the placeholder for the real prompt and keeps page fields", () => {
    const out = rewriteConversationBody(pageBody(), { prompt: "real prompt", model: "gpt-6-thinking", effort: "high" });
    expect(out.messages[0].content.parts).toEqual(["real prompt"]);
    expect(out.messages[0].id).toBe("m1");
    expect(out.history_and_training_disabled).toBe(true);
    expect(out.thinking_effort).toBe("extended");
  });

  test("drops thinking_effort for models without configurable effort", () => {
    const body = { ...pageBody(), thinking_effort: "standard" };
    const out = rewriteConversationBody(body, { prompt: "p", model: "gpt-6-instant", effort: "high" });
    expect(out.model).toBe("gpt-6-instant");
    expect("thinking_effort" in out).toBe(false);
  });

  test("forces temporary-chat flags even when the page did not set them", () => {
    const { history_and_training_disabled: _, ...body } = pageBody();
    const out = rewriteConversationBody(body, { prompt: "p", model: "gpt-6-thinking", effort: "high" });
    expect(out.history_and_training_disabled).toBe(true);
    expect(out.is_do_not_remember).toBe(true);
  });

  test("does not mutate the page body", () => {
    const body = pageBody();
    rewriteConversationBody(body, { prompt: "p", model: "gpt-6-thinking", effort: "low" });
    expect(body.messages[0].content.parts).toEqual(["."]);
  });
});

describe("extractFinalAnswer", () => {
  const node = (id, message) => [id, { message }];
  test("returns the latest final assistant text and strips <escape>", () => {
    const conversation = {
      mapping: Object.fromEntries([
        node("a", { author: { role: "assistant" }, channel: "analysis", content: { content_type: "text", parts: ["thinking"] }, create_time: 3 }),
        node("b", { author: { role: "assistant" }, content: { content_type: "text", parts: ["old"] }, status: "finished_successfully", create_time: 1 }),
        node("c", { author: { role: "assistant" }, content: { content_type: "text", parts: ["<escape><x>6</x></escape>"] }, status: "finished_successfully", create_time: 2, metadata: { model_slug: "gpt-6-thinking" } }),
        node("d", { author: { role: "user" }, content: { content_type: "text", parts: ["q"] }, create_time: 4 }),
      ]),
    };
    expect(extractFinalAnswer(conversation)).toEqual({ text: "<x>6</x>", status: "finished_successfully", model: "gpt-6-thinking" });
  });

  test("returns null when there is no assistant text", () => {
    expect(extractFinalAnswer({ mapping: {} })).toBe(null);
  });
});

describe("checkDailyBudget", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  test("passes under budget and ignores sends older than 24h", () => {
    const result = checkDailyBudget([now - 25 * 60 * 60 * 1000, now - 1000], 2, now);
    expect(result.ok).toBe(true);
    expect(result.recent).toEqual([now - 1000]);
  });

  test("blocks at budget until the oldest counted send ages out", () => {
    const oldest = now - 23 * 60 * 60 * 1000;
    const result = checkDailyBudget([oldest, now - 1000], 2, now);
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBe(60 * 60 * 1000);
  });
});
