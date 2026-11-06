/** Template snapshots per locale (lld/notify.md §8): subject, text and HTML of every sample. */
import { describe, expect, it } from "vitest";
import { createRenderer } from "../../src/app/render.js";
import { selfCheck } from "../../src/app/services.js";
import { LOCALES, TEMPLATE_NAMES } from "../../src/domain/template/catalogue.js";
import { SAMPLES } from "../../src/domain/template/samples.js";

const render = createRenderer();

describe.each(LOCALES)("templates (%s)", (locale) => {
  for (const t of TEMPLATE_NAMES)
    SAMPLES[t].forEach((v, i) => {
      it(`${t} #${i + 1}`, async () => {
        const r = await render(t, v, locale);
        const base = `../__snapshots__/${locale}/${t}.${i + 1}`;
        await expect(`Subject: ${r.subject}\n\n${r.text}`).toMatchFileSnapshot(`${base}.txt`);
        await expect(r.html).toMatchFileSnapshot(`${base}.html`);
        expect(r.html).toMatch(/^<!doctype html>/i);
        expect(r.html).toContain(`lang="${locale}"`);
        expect(r.html).toContain(r.subject.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
      });
    });
});

describe("rendering safety", () => {
  it("escapes variables in the HTML part", async () => {
    const r = await render("payment.receipt", SAMPLES["payment.receipt"][1], "en");
    expect(r.html).toContain("Acme &lt;Test&gt; &amp; Co");
    expect(r.html).not.toContain("<Test>");
    expect(r.text).toContain("Acme <Test> & Co");
  });
  it("refuses invalid variables before rendering", async () => {
    await expect(
      render("auth.magic_link", { link_url: "javascript:x", purpose: "signup", expires_in_minutes: 5 }, "en"),
    ).rejects.toThrow(/invalid variables/);
  });
  it("a broken layout fails (MJML is validated strictly)", async () => {
    const broken = createRenderer(
      '<mjml lang="{{lang}}"><mj-body><mj-section><mj-column><mj-bogus/>{{content}}</mj-column></mj-section></mj-body>{{title}}{{preheader}}{{footer}}</mjml>',
    );
    await expect(broken("account.reinstated", SAMPLES["account.reinstated"][0], "en")).rejects.toThrow(/mj-bogus/);
  });
  it("the self-check renders every sample", async () => {
    expect(await selfCheck(render)).toBe(TEMPLATE_NAMES.reduce((n, t) => n + SAMPLES[t].length, 0));
  });
});
