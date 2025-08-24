// package.json: { "type": "module" }
// deps: jsdom, node-fetch, iconv-lite
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

    // ▼▼▼ EUC-KR 대응: 바이너리로 받고 charset 감지 후 디코딩
    const buf = Buffer.from(await r.arrayBuffer());
    const ct  = (r.headers.get("content-type") || "").toLowerCase();
    // 헤더/메타 태그로 charset 추정
    let charset = /charset=([\w-]+)/i.test(ct) ? RegExp.$1.toLowerCase() : "";
    if (!charset) {
      // meta 태그에서 한번 더 시도 (대충 검사)
      const headProbe = buf.toString("ascii");
      const m1 = headProbe.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
      const m2 = headProbe.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
      charset = (m1?.[1] || m2?.[1] || "utf-8").toLowerCase();
    }
    if (/euc-kr|ks_c_5601|cp949/.test(charset)) charset = "euc-kr";
    const html = iconv.decode(buf, charset || "utf-8");
    // ▲▲▲ 여기까지가 핵심

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
    bible.querySelectorAl
