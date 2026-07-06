import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  AlertNotifier,
  EmailChannel,
  WebhookChannel,
  createAlertNotifier,
  renderAlertText
} from "../packages/notifier/dist/index.js";

const samplePayload = {
  id: "generation.failure-rate",
  severity: "critical",
  area: "generation",
  metric: "generationFailureRate",
  value: 0.8,
  threshold: 0.35,
  message: "Generation failure rate is above threshold.",
  runbook: "Disable generation, inspect provider failures."
};

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("renderAlertText includes severity, metric, threshold and runbook", () => {
  const text = renderAlertText(samplePayload);
  assert.match(text, /CRITICAL/);
  assert.match(text, /generationFailureRate = 0.8 \(threshold 0.35\)/);
  assert.match(text, /Runbook: Disable generation/);
  assert.match(text, /Alert: generation.failure-rate/);
});

test("WebhookChannel posts structured JSON payload and succeeds on 2xx", async () => {
  let received = null;
  const { server, url } = await startServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received = { method: req.method, contentType: req.headers["content-type"], body: JSON.parse(body) };
      res.writeHead(200);
      res.end("ok");
    });
  });
  try {
    const channel = new WebhookChannel({ url });
    await channel.send(samplePayload);
    assert.equal(received.method, "POST");
    assert.match(received.contentType, /application\/json/);
    assert.equal(received.body.id, "generation.failure-rate");
    assert.equal(received.body.severity, "critical");
    assert.equal(received.body.value, 0.8);
    assert.match(received.body.text, /CRITICAL/);
  } finally {
    await closeServer(server);
  }
});

test("WebhookChannel throws on non-2xx after exhausting attempts", async () => {
  let attempts = 0;
  const { server, url } = await startServer((req, res) => {
    attempts += 1;
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const channel = new WebhookChannel({ url, maxAttempts: 3 });
    await assert.rejects(() => channel.send(samplePayload), /status 500/);
    assert.equal(attempts, 3);
  } finally {
    await closeServer(server);
  }
});

test("WebhookChannel aborts on timeout", async () => {
  const { server, url } = await startServer((req, res) => {
    // Never respond — force the timeout to fire.
    setTimeout(() => {
      res.writeHead(200);
      res.end("late");
    }, 2000).unref();
  });
  try {
    const channel = new WebhookChannel({ url, timeoutMs: 100, maxAttempts: 1 });
    await assert.rejects(() => channel.send(samplePayload));
  } finally {
    await closeServer(server);
  }
});

test("EmailChannel renders subject/body with severity and delegates to mailer", async () => {
  const sent = [];
  const fakeMailer = {
    async sendEmail(input) {
      sent.push(input);
    }
  };
  const channel = new EmailChannel({ mailer: fakeMailer, recipients: "ops@imagora.example" });
  await channel.send(samplePayload);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ops@imagora.example");
  assert.match(sent[0].subject, /\[CRITICAL\]/);
  assert.match(sent[0].subject, /Generation failure rate/);
  assert.match(sent[0].text, /Runbook:/);
  assert.match(sent[0].html, /CRITICAL/);
  assert.match(sent[0].html, /generationFailureRate/);
});

test("EmailChannel surfaces mailer failure", async () => {
  const failingMailer = {
    async sendEmail() {
      throw new Error("smtp down");
    }
  };
  const channel = new EmailChannel({ mailer: failingMailer, recipients: "ops@imagora.example" });
  await assert.rejects(() => channel.send(samplePayload), /smtp down/);
});

test("AlertNotifier.dispatch collects per-channel results without throwing", async () => {
  const okChannel = { name: "ok", async send() {} };
  const badChannel = {
    name: "bad",
    async send() {
      throw new Error("channel exploded");
    }
  };
  const notifier = new AlertNotifier([okChannel, badChannel]);
  const results = await notifier.dispatch(samplePayload);
  assert.equal(results.length, 2);
  const ok = results.find((r) => r.channel === "ok");
  const bad = results.find((r) => r.channel === "bad");
  assert.equal(ok.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /channel exploded/);
});

test("AlertNotifier.dispatch can target a subset of channels", async () => {
  const calls = [];
  const channelA = { name: "a", async send() { calls.push("a"); } };
  const channelB = { name: "b", async send() { calls.push("b"); } };
  const notifier = new AlertNotifier([channelA, channelB]);
  const results = await notifier.dispatch(samplePayload, { channels: ["b"] });
  assert.deepEqual(calls, ["b"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].channel, "b");
});

test("createAlertNotifier builds channels from env and reports none when unset", () => {
  const empty = createAlertNotifier({ mailer: { async sendEmail() {} }, env: {} });
  assert.equal(empty.hasChannels(), false);
  assert.deepEqual(empty.channelNames, []);

  const webhookOnly = createAlertNotifier({
    mailer: { async sendEmail() {} },
    env: { ALERT_WEBHOOK_URL: "https://hooks.imagora.example/alert" }
  });
  assert.deepEqual(webhookOnly.channelNames, ["webhook"]);

  const both = createAlertNotifier({
    mailer: { async sendEmail() {} },
    env: { ALERT_WEBHOOK_URL: "https://hooks.imagora.example/alert", ALERT_EMAIL_TO: "ops@imagora.example" }
  });
  assert.deepEqual(both.channelNames, ["webhook", "email"]);
  assert.equal(both.hasChannels(), true);
});
