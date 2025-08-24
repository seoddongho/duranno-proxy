import { Buffer } from "node:buffer";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";

export default async function handler(req, res) {
  try {
    // 한국시간 오늘
    const nowKST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const y = nowKST.getFullYear(), m = String(nowKST.getMonth() + 1).padStart(2, "0"), d = String(nowKST.getDate()).padStart(2, "0");
    const date = (req.query.date || `${y}-${m}-${d}`);
    const version = (req.query.d || "k");

    const src = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(date)}&d=${encodeURIComponent(version)}`;

    // 원본 바이너리 가져오기
    const r = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`Upstream ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    // **강제로 EUC-KR로 디코딩**
    const html = iconv.decode(buf, "euc-kr");

    // DOM 파싱
    const dom = new JSDOM(html, { url: src });
    const doc = dom.window.document;

    const bible = doc.querySelector("div.contents.right.last-div .bible");
    if (!bible) {
      res.status(404).json({ error: "본문을 찾을 수 없음", source: src });
      return;
    }

    // 불필요 태그 제거
    bible.querySelectorAll("script,noscript").forEach((el) => el.remove());

    const title = doc.querySelector(".font-size h1 em")?.textContent || "오늘의 말씀";

    // JSON 응답
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      date,
      version,
      title,
      html: bible.outerHTML,
      source: src
    });

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
