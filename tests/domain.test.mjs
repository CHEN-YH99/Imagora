import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInitialData, JsonStore, verifyPassword } from "../packages/database/dist/index.js";
import { SmtpMailer } from "../packages/mailer/dist/index.js";
import { StripePaymentProvider } from "../packages/payments/dist/index.js";
import { calculateCreditCost, checkPromptSafety } from "../packages/shared/dist/index.js";

test("credit cost increases with quantity and quality", () => {
  const standardOne = calculateCreditCost({
    style: "product_photography",
    quality: "standard",
    quantity: 1,
    aspectRatio: "1:1"
  });
  const highTwo = calculateCreditCost({
    style: "product_photography",
    quality: "high",
    quantity: 2,
    aspectRatio: "1:1"
  });

  assert.equal(standardOne, 7);
  assert.ok(highTwo > standardOne * 2);
});

test("local prompt safety blocks configured terms", () => {
  const result = checkPromptSafety("child abuse scene");
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reasonCode, "LOCAL_RULE_HIT");
});

test("seed users have verifiable password hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "imagora-store-"));
  const store = new JsonStore(join(dir, "store.json"));
  const data = await store.read();
  const demo = data.users.find((user) => user.email === "demo@imagora.local");

  assert.ok(demo);
  assert.equal(verifyPassword("Demo123!", demo.passwordHash), true);
  assert.equal(data.plans.length, 3);

  await rm(dir, { recursive: true, force: true });
});

test("production initial data requires explicit bootstrap admin credentials", () => {
  const previous = snapshotEnv([
    "NODE_ENV",
    "IMAGORA_SEED_DEMO_DATA",
    "IMAGORA_BOOTSTRAP_ADMIN_EMAIL",
    "IMAGORA_BOOTSTRAP_ADMIN_PASSWORD"
  ]);
  try {
    process.env.NODE_ENV = "production";
    delete process.env.IMAGORA_SEED_DEMO_DATA;
    delete process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD;

    assert.throws(() => createInitialData(), /IMAGORA_BOOTSTRAP_ADMIN_EMAIL/);
  } finally {
    restoreEnv(previous);
  }
});

test("production bootstrap admin uses configured credentials", () => {
  const previous = snapshotEnv([
    "NODE_ENV",
    "IMAGORA_SEED_DEMO_DATA",
    "IMAGORA_BOOTSTRAP_ADMIN_EMAIL",
    "IMAGORA_BOOTSTRAP_ADMIN_PASSWORD"
  ]);
  try {
    process.env.NODE_ENV = "production";
    delete process.env.IMAGORA_SEED_DEMO_DATA;
    process.env.IMAGORA_BOOTSTRAP_ADMIN_EMAIL = "owner@example.com";
    process.env.IMAGORA_BOOTSTRAP_ADMIN_PASSWORD = "Owner123!";

    const data = createInitialData();
    assert.equal(data.users.length, 1);
    assert.equal(data.users[0].email, "owner@example.com");
    assert.equal(data.users[0].role, "ADMIN");
    assert.equal(verifyPassword("Owner123!", data.users[0].passwordHash), true);
    assert.equal(
      data.users.some((user) => user.email === "admin@imagora.local"),
      false
    );
  } finally {
    restoreEnv(previous);
  }
});

test("smtp mailer sends an authenticated MIME message", async () => {
  const smtp = createFakeSmtpServer();
  const previous = snapshotEnv([
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_FROM_NAME",
    "SMTP_REQUIRE_TLS",
    "SMTP_SECURE",
    "SMTP_TIMEOUT_MS"
  ]);

  await smtp.listen();
  try {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = "smtp-user";
    process.env.SMTP_PASSWORD = "smtp-password";
    process.env.SMTP_FROM = "no-reply@example.com";
    process.env.SMTP_FROM_NAME = "Imagora Tests";
    process.env.SMTP_REQUIRE_TLS = "false";
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_TIMEOUT_MS = "2000";

    await new SmtpMailer().sendEmail({
      to: "Recipient <recipient@example.com>",
      subject: "SMTP smoke",
      text: "Plain body from SMTP test.",
      html: "<p>HTML body from SMTP test.</p>"
    });

    assert.ok(smtp.commands.some((command) => command.startsWith("EHLO ")));
    assert.ok(smtp.commands.some((command) => command.startsWith("AUTH PLAIN ")));
    assert.ok(smtp.commands.includes("MAIL FROM:<no-reply@example.com>"));
    assert.ok(smtp.commands.includes("RCPT TO:<recipient@example.com>"));
    assert.match(smtp.message, /From: "Imagora Tests" <no-reply@example\.com>/);
    assert.match(smtp.message, /To: Recipient <recipient@example\.com>/);
    assert.match(smtp.message, /Subject: SMTP smoke/);
    assert.match(smtp.message, /Plain body from SMTP test\./);
    assert.match(smtp.message, /<p>HTML body from SMTP test\.<\/p>/);
  } finally {
    restoreEnv(previous);
    await smtp.close();
  }
});

test("stripe webhook accepts a matching signature when multiple v1 signatures are present", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_TOLERANCE_SECONDS"]);
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = "300";

    const payload = JSON.stringify({
      id: "evt_multi_signature",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 9900,
          metadata: {
            orderId: "order_multi_signature"
          }
        }
      }
    });
    const timestamp = currentStripeTimestamp();
    const validSignature = stripeSignature(process.env.STRIPE_WEBHOOK_SECRET, timestamp, payload);
    const invalidSignature = "0".repeat(64);
    const header = `t=${timestamp},v1=${validSignature},v1=${invalidSignature}`;

    const event = await new StripePaymentProvider().verifyWebhook(payload, header);

    assert.equal(event.provider, "stripe");
    assert.equal(event.providerEventId, "evt_multi_signature");
    assert.equal(event.orderId, "order_multi_signature");
    assert.equal(event.amountCents, 9900);
  } finally {
    restoreEnv(previous);
  }
});

test("stripe webhook rejects a payload that no longer matches the signature", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_TOLERANCE_SECONDS"]);
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = "300";

    const originalPayload = JSON.stringify({
      id: "evt_signed_payload",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 9900,
          metadata: {
            orderId: "order_signed_payload"
          }
        }
      }
    });
    const tamperedPayload = JSON.stringify({
      id: "evt_signed_payload",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 1,
          metadata: {
            orderId: "order_signed_payload"
          }
        }
      }
    });
    const timestamp = currentStripeTimestamp();
    const header = `t=${timestamp},v1=${stripeSignature(process.env.STRIPE_WEBHOOK_SECRET, timestamp, originalPayload)}`;

    await assert.rejects(
      () => new StripePaymentProvider().verifyWebhook(tamperedPayload, header),
      /Invalid Stripe webhook signature/
    );
  } finally {
    restoreEnv(previous);
  }
});

test("stripe webhook rejects signatures outside the timestamp tolerance", async () => {
  const previous = snapshotEnv(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_TOLERANCE_SECONDS"]);
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_local";
    process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS = "1";

    const payload = JSON.stringify({
      id: "evt_stale_signature",
      type: "checkout.session.completed",
      data: {
        object: {
          amount_total: 9900,
          metadata: {
            orderId: "order_stale_signature"
          }
        }
      }
    });
    const timestamp = String(Math.floor(Date.now() / 1000) - 10);
    const header = `t=${timestamp},v1=${stripeSignature(process.env.STRIPE_WEBHOOK_SECRET, timestamp, payload)}`;

    await assert.rejects(
      () => new StripePaymentProvider().verifyWebhook(payload, header),
      /timestamp is outside tolerance/
    );
  } finally {
    restoreEnv(previous);
  }
});

function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function currentStripeTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

function stripeSignature(secret, timestamp, payload) {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

function createFakeSmtpServer() {
  const commands = [];
  let message = "";
  let port = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    let receivingData = false;
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp.local ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.length) {
        if (receivingData) {
          const dataEnd = buffer.indexOf("\r\n.\r\n");
          if (dataEnd === -1) {
            return;
          }
          message += buffer.slice(0, dataEnd);
          buffer = buffer.slice(dataEnd + 5);
          receivingData = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) {
          return;
        }
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        commands.push(line);

        if (line.startsWith("EHLO ")) {
          socket.write("250-fake.smtp.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        } else if (line.startsWith("AUTH PLAIN ")) {
          socket.write("235 2.7.0 authenticated\r\n");
        } else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) {
          socket.write("250 2.1.0 ok\r\n");
        } else if (line === "DATA") {
          receivingData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (line === "QUIT") {
          socket.write("221 2.0.0 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });

  return {
    commands,
    get message() {
      return message;
    },
    get port() {
      return port;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          assert.ok(address && typeof address === "object");
          port = address.port;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
