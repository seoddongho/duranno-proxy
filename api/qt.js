import { Buffer } from "node:buffer";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";

export default async function handler(req, res) {
  try {
    // 오늘 날짜 기본값 (KST)
    const nowKST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const y = nowKST.getFullYear(), m = String(nowKST.getMonth() + 1).padStart(2, "0"), d = String(nowKST.getDate()).padStart(2, "0");
    const date = (req.query.date || `${y}-${m}-${d}`);
    const version = (req.query.d || "k");
    const format  = (req.query.format || "json");

    const src = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(date)}&d=${encodeURIComponent(version)}`;
    const r = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    // 강제 EUC-KR → UTF-8
    const html = iconv.decode(buf, "euc-kr");

    const dom = new JSDOM(html, { url: src });
    const doc = dom.window.document;
    const bible = doc.querySelector("div.contents.right.last-div .bible");
    if (!bible) {
      res.status(404).json({ error: "본문을 찾을 수 없음", source: src });
      return;
    }
    bible.querySelectorAll("script,noscript").forEach(el => el.remove());

    const title = doc.querySelector(".font-size h1 em")?.textContent || "오늘의 말씀";

    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`
        <!doctype html><meta charset="utf-8">
        <h3>${title} (${date})</h3>
        ${bible.outerHTML}
        <hr><small>source: ${src}</small>
      `);
      return;
    }

    // JSON 안전하게 출력
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify({
      date,
      version,
      title,
      html: bible.outerHTML,
      source: src
    }, null, 2));

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
