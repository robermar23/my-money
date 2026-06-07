// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { type MailMessage, notifyNewAlerts } from "./notify.ts";

const SMTP_ENV = {
  SMTP_URL: "smtp://user:pass@mail.example.com:587",
  ALERT_EMAIL_TO: "me@example.com",
  APP_BASE_URL: "https://money.example.com",
};

describe("notifyNewAlerts", () => {
  it("does not send (no throw) when SMTP is unconfigured", async () => {
    const send = vi.fn();
    const result = await notifyNewAlerts(3, "2026-06-07", {
      env: {},
      createTransport: () => ({ sendMail: send }),
    });
    expect(result).toEqual({ sent: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send when there are zero new alerts", async () => {
    const send = vi.fn();
    await notifyNewAlerts(0, "2026-06-07", {
      env: SMTP_ENV,
      createTransport: () => ({ sendMail: send }),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends exactly one content-free email and leaks NO financial data", async () => {
    let captured: MailMessage | undefined;
    const send = vi.fn(async (msg: MailMessage) => {
      captured = msg;
    });

    const result = await notifyNewAlerts(2, "2026-06-07", {
      env: SMTP_ENV,
      createTransport: () => ({ sendMail: send }),
    });

    expect(result).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(captured?.to).toBe("me@example.com");
    expect(captured?.text).toMatch(/2 new alerts/);
    expect(captured?.text).toContain("https://money.example.com/alerts");

    // Privacy regression: the body must contain NONE of these financial strings.
    const financialFixtures = [
      "1234.56",
      "$",
      "Starbucks",
      "M&T",
      "Checking",
      "AAPL",
      "Mortgage",
      "balance",
    ];
    const body = `${captured?.subject}\n${captured?.text}`;
    for (const f of financialFixtures) {
      expect(body).not.toContain(f);
    }
  });
});
