/**
 * SMTP authentication against a Mailpit that requires credentials (Resend's shape: user `resend`, the API key as
 * the password from a secret file). TLS is exercised by the unit tests (options); Mailpit here is plain SMTP, which
 * the `test` stage allows.
 */
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/providers/provider.js";
import { smtpProvider } from "../../src/providers/smtp.js";

let container: StartedTestContainer;
let smtpUrl: string;
let apiUrl: string;
beforeAll(async () => {
  container = await new GenericContainer("axllent/mailpit:v1.27.11")
    .withEnvironment({ MP_SMTP_AUTH: "resend:re_test_key", MP_SMTP_AUTH_ALLOW_INSECURE: "1" })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/readyz", 8025).forStatusCode(200))
    .withStartupTimeout(60_000)
    .start();
  smtpUrl = `smtp://${container.getHost()}:${container.getMappedPort(1025)}`;
  apiUrl = `http://${container.getHost()}:${container.getMappedPort(8025)}`;
});
afterAll(async () => {
  await container?.stop();
});

const mail = (id: string) => ({
  id,
  from: "NearPay <receipts@nearpay.money>",
  replyTo: "nearpaydotmoney@gmail.com",
  to: "payer@example.test",
  subject: "Receipt",
  html: "<p>Paid</p>",
  text: "Paid",
});

describe("SMTP authentication", () => {
  it("authenticates with the user and the secret-file password; sets From, Reply-To and the auto-reply headers", async () => {
    const p = smtpProvider({
      url: smtpUrl,
      timeoutMs: 5_000,
      domain: "nearpay.money",
      env: "test",
      user: "resend",
      password: "re_test_key",
    });
    const r = await p.send(mail("018f0000-0000-7000-8000-0000000000a1"));
    expect(r.providerMessageId).toBe("<018f0000-0000-7000-8000-0000000000a1@nearpay.money>");
    await p.close?.();
    const list = (await (await fetch(`${apiUrl}/api/v1/messages`)).json()) as { messages: { ID: string }[] };
    expect(list.messages).toHaveLength(1);
    const h = (await (await fetch(`${apiUrl}/api/v1/message/${list.messages[0]?.ID}/headers`)).json()) as Record<
      string,
      string[]
    >;
    expect(h.From?.[0]).toBe("NearPay <receipts@nearpay.money>");
    expect(h["Reply-To"]?.[0]).toBe("nearpaydotmoney@gmail.com");
    expect(h["Auto-Submitted"]?.[0]).toBe("auto-generated");
    expect(h["X-Auto-Response-Suppress"]?.[0]).toBe("All");
  });

  it("a wrong password is a transient failure that never suppresses the recipient", async () => {
    const p = smtpProvider({
      url: smtpUrl,
      timeoutMs: 5_000,
      domain: "nearpay.money",
      env: "test",
      user: "resend",
      password: "wrong",
    });
    const e = await p.send(mail("018f0000-0000-7000-8000-0000000000a2")).catch((x: unknown) => x);
    await p.close?.();
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ permanent: false, recipientRejected: false });
  });
});
