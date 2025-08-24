// api/qt.js
export const config = { runtime: 'nodejs18.x' }; // ★ 중요: Edge가 아닌 Node 런타임으로

import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";

export default async function handler(req, res) {
  try {
    // 한국시간 오늘
    const nowKST = new Date(new Date().toLocaleString("en-US",{ timeZone:"Asia/Seoul" }));
    const y = nowKST.getFullYear(), m = String(nowKST.getMonth()+1).padStart(2,"0"), d = String(nowKST.getDate()).padStart(2,"0");
    const date = (req.query.date || `${y}-${m}-${d}`).toString();
    const version = (req.query.d || "k").toString(); // k|w
    const format  = (req.query.format || "json").toString(); // json|html (디버그용)

    const src = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(date)}&d=${encodeURIComponent(version)}`;
    const r = await fetch(src, { headers:{ "User-Agent":"Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);

    // EUC-KR 대응
    const buf = Buffer.from(await r.arrayBuffer());
    const ct  = (r.headers.get("content-type") || "").toLowerCase();

    let charset = /charset=([\w-]+)/i.test(ct) ? RegExp.$1.toLowerCase() : "";
    if (!charset) {
      const headProbe = buf.toString("ascii");
      const m1 = headProbe.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
      const m2 = headProbe.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
      charset = (m1?.[1] || m2?.[1] || "utf-8").toLowerCase();
    }
    if (/euc-kr|ks_c_5601|cp949/.test(charset)) charset = "euc-kr";

    const html = iconv.decode(buf, charset || "utf-8");

    const dom = new JSDOM(html, { url: src });
    const doc = dom.window.document;
    const bible = doc.querySelector("div.contents.right.last-div .bible");
    if (!bible) {
      res.status(404).json({ error:"bible element not found", charset, source: src });
      return;
    }

    // 정리
    bible.querySelectorAll("script,noscript").forEach(el => el.remove());
    bible.querySelectorAll("a[href]").forEach(a => a.href = new URL(a.getAttribute("href"), src).toString());
    bible.querySelectorAll("img[src]").forEach(i => i.src = new URL(i.getAttribute("src"), src).toString());

    const title = doc.querySelector(".font-size h1 em")?.textContent || "오늘의 말씀";

    if (format === "html") {
      res.setHeader("Content-Type","text/html; charset=utf-8");
      res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=86400");
      res.status(200).send(`<!doctype html><meta charset="utf-8">
        <h3>${title} (${date})</h3><div>${bible.outerHTML}</div>
        <hr><small>source: ${src} · charset: ${charset}</small>`);
      return;
    }

    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ date, version, html: bible.outerHTML, source: src, title, charset });
  } catch (e) {
    // 에러 내용을 바로 확인할 수 있게 반환
    res.status(500).json({ error: String(e) });
  }
}
