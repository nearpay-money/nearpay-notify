import { describe, expect, it } from "vitest";
import {
  type Content,
  contentMjml,
  contentText,
  escapeHtml,
  fillLayout,
  LinkError,
  safeHref,
  safeSubject,
} from "../../src/domain/template/blocks.js";

describe("escaping and links", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
    expect(escapeHtml("plain text")).toBe("plain text");
  });
  it("accepts only absolute http(s) URLs without credentials", () => {
    expect(safeHref("https://dashboard.nearpay.localhost/a?b=1&c=2")).toBe(
      "https://dashboard.nearpay.localhost/a?b=1&c=2",
    );
    expect(safeHref("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "/relative",
      "mailto:a@b.c",
      "https://user:pw@evil.example",
      "not a url",
    ])
      expect(() => safeHref(bad), bad).toThrow(LinkError);
  });
  it("keeps subjects on one bounded line (no header injection)", () => {
    expect(safeSubject("Hello\r\nBcc: victim@example.com")).toBe("Hello Bcc: victim@example.com");
    expect(safeSubject(` ${"x".repeat(300)} `)).toHaveLength(200);
    expect(safeSubject("x".repeat(300)).endsWith("...")).toBe(true);
  });
});

const content: Content = {
  subject: "S",
  preheader: "P",
  heading: "Hi <b>",
  blocks: [
    { kind: "p", text: "Para & more" },
    { kind: "note", text: "small" },
    { kind: "code", label: "Address", text: "0xabc" },
    { kind: "facts", rows: [["Amount", "25.00 USD"]] },
    { kind: "button", label: "Go", href: "https://a.example/x?y=1&z=2" },
    { kind: "links", label: "Proof:", hrefs: ["https://e.example/tx/1", "https://e.example/tx/2"] },
  ],
};

describe("content rendering", () => {
  it("MJML escapes text and attributes", () => {
    const m = contentMjml(content);
    expect(m).toContain("Hi &lt;b&gt;");
    expect(m).toContain("Para &amp; more");
    expect(m).toContain('href="https://a.example/x?y=1&amp;z=2"');
    expect(m).toContain("<mj-table");
    expect(m).toContain('<a href="https://e.example/tx/2"');
    expect(m).not.toContain("<b>");
  });
  it("refuses unsafe links in either part", () => {
    const bad: Content = { ...content, blocks: [{ kind: "button", label: "x", href: "javascript:alert(1)" }] };
    expect(() => contentMjml(bad)).toThrow(LinkError);
    expect(() => contentText(bad, "f")).toThrow(LinkError);
    const badLinks: Content = { ...content, blocks: [{ kind: "links", label: "x", hrefs: ["data:x"] }] };
    expect(() => contentMjml(badLinks)).toThrow(LinkError);
  });
  it("plain text lists every block and the footer", () => {
    expect(contentText(content, "Footer")).toBe(
      [
        "Hi <b>",
        "",
        "Para & more",
        "",
        "small",
        "",
        "Address:",
        "  0xabc",
        "",
        "Amount: 25.00 USD",
        "",
        "Go: https://a.example/x?y=1&z=2",
        "",
        "Proof:",
        "  https://e.example/tx/1",
        "  https://e.example/tx/2",
        "",
        "--",
        "Footer",
        "",
      ].join("\n"),
    );
  });
});

describe("fillLayout", () => {
  it("fills slots once (values are not re-scanned) and rejects unknown slots", () => {
    expect(fillLayout("<a>{{x}}</a><b>{{y}}</b>", { x: "{{y}}", y: "2" })).toBe("<a>{{y}}</a><b>2</b>");
    expect(() => fillLayout("{{missing}}", {})).toThrow(/missing/);
  });
});
