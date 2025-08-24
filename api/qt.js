import { Buffer } from "node:buffer";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";

// ── 공통 CORS 헤더 ──
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // 필요시 * 대신 네 도메인으로 제한
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end(); // 프리플라이트 응답
    return;
  }

  try {
    // 오늘 날짜 (KST)
    const nowKST = new Date(new Date().toLocaleString("en-US",{ timeZone:"Asia/Seoul" }));
    const y = nowKST.getFullYear(), m = String(nowKST.getMonth()+1).padStart(2,"0"), d = String(nowKST.getDate()).padStart(2,"0");
    const date = (req.query.date || `${y}-${m}-${d}`);
    const version = (req.query.d || "k");
    const format  = (req.query.format || "json");

    const src = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(date)}&d=${encodeURIComponent(version)}`;
    const r = await fetch(src, { headers:{ "User-Agent":"Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);

    const buf  = Buffer.from(await r.arrayBuffer());
    const html = iconv.decode(buf, "euc-kr"); // EUC-KR -> UTF-8

    const dom = new JSDOM(html, { url: src });
    const doc = dom.window.document;
    const bible = doc.querySelector("div.contents.right.last-div .bible");
    if (!bible) { res.status(404).json({ error:"본문을 찾을 수 없음", source: src }); return; }
    bible.querySelectorAll("script,noscript").forEach(el => el.remove());
    const title = doc.querySelector(".font-size h1 em")?.textContent || "오늘의 말씀";

    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // 깔끔한 조각만 반환 (doctype/meta 제거)
      res.status(200).send(`<div class="qt-fragment"><h3 style="margin:0 0 .5rem">${title} (${date})</h3>${bible.outerHTML}</div>`);
      return;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(JSON.stringify({ date, version, title, html: bible.outerHTML, source: src }, null, 2));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
