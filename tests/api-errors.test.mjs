import { execFileSync } from "node:child_process";
import test from "node:test";

test("API client preserves validation details and explains prompt length failures", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { ApiRequestError, formatApiErrorMessage } from "./apps/web/lib/api/errors.ts";
    import { apiFetch } from "./apps/web/lib/api/client.ts";

    const details = {
      formErrors: [],
      fieldErrors: { prompt: ["String must contain at most 7000 character(s)"] }
    };
    const expectedMessage = "提示词最多支持 7000 个字符，请精简后重试。";
    assert.equal(formatApiErrorMessage("VALIDATION_ERROR", "Invalid request payload", 400, details), expectedMessage);
    assert.equal(
      formatApiErrorMessage("VALIDATION_ERROR", "Invalid request payload", 400, {
        fieldErrors: { negativePrompt: ["String must contain at most 800 character(s)"] }
      }),
      "负向提示词最多支持 800 个字符，请精简后重试。"
    );
    for (const invalidDetails of [null, [], { fieldErrors: null }, { fieldErrors: { prompt: "private value" } }, {
      fieldErrors: { prompt: ["internal private value"] }
    }]) {
      assert.equal(
        formatApiErrorMessage("VALIDATION_ERROR", "Invalid request payload", 400, invalidDetails),
        "提交内容格式不正确，请检查后重试。"
      );
    }
    assert.equal(formatApiErrorMessage("INTERNAL_ERROR", "private value", 500, details), "服务暂时异常，请稍后重试。");
    assert.equal(formatApiErrorMessage("UNKNOWN", "private value", 400), "请求失败，请稍后重试。（400）");

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "VALIDATION_ERROR", message: "Invalid request payload", details }
    }), { status: 400, headers: { "Content-Type": "application/json" } });
    await assert.rejects(apiFetch("/api/generation/tasks", { method: "POST", body: {} }), error => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.message, expectedMessage);
      assert.deepEqual(error.details, details);
      return true;
    });
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: "pipe"
  });
});
