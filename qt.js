// package.json 에 "type": "module" 필수
// 설치: npm i jsdom node-fetch
import fetch from "node-fetch";
import { JSDOM } from "jsdom";

export default async function handler(req, res) {
  try {
    // 한국시간 오늘 (date 파라미터 없으면 오늘)
    const nowKST = new Date(new Date().toLocaleString("en-US",{ timeZone:"Asia/Seoul" }));
    const y = nowKST.getFullYear(), m = String(nowKST.getMonth()+1).padStart(2,"0"), d = String(nowKST.getDate()).padStart(2,"0");
    const date = (req.query.date || `${y}-${m}-${d}`).toString();
    const version = (req.query.d || "k").toString(); // k:개역개정, w:우리말성경

    const src = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(date)}&d=${encodeURIComponent(version)}`;
    const r = await fetch(src, { headers:{ "User-Agent":"Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);
    const html = await r.text();

    const dom = new JSDOM(html, { url: src });
    const doc = dom.window.document;
    const bible = doc.querySelector("div.contents.right.last-div .bible");
    if (!bible) return res.status(404).json({ error:"bible element not found" });

    // 깨끗하게
    bible.querySelectorAll("script,noscript").forEach(el => el.remove());
    bible.querySelectorAll("a[href]").forEach(a => a.href = new URL(a.getAttribute("href"), src).toString());
    bible.querySelectorAll("img[src]").forEach(i => i.src = new URL(i.getAttribute("src"), src).toString());

    res.setHeader("Content-Type","application/json; charset=utf-8");
    res.setHeader("Cache-Control","s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      date, version,
      html: bible.outerHTML,         // ← 이걸 그대로 innerHTML로 넣어 쓰면 됨
      source: src,
      title: doc.querySelector(".font-size h1 em")?.textContent || "오늘의 말씀",
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}