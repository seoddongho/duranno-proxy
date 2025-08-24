// api/qt.js
// deps: node-fetch, jsdom, iconv-lite
// package.json: { "type": "module" }

import { Buffer } from "node:buffer";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import iconv from "iconv-lite";

/** CORS 공통 헤더 */
function setCors(res) {
  // 필요하면 "*" 대신 네 도메인으로 제한 가능 (예: https://example.com)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** 한국시간 yyyy-mm-dd */
function todayKST() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** charset 추정 (Content-Type 헤더 + meta 스니핑) */
function guessCharset(contentType, buf) {
  let charset =
    /charset=([\w-]+)/i.test(contentType || "") ? RegExp.$1.toLowerCase() : "";

  if (!charset) {
    // HTML <meta>에서 한 번 더 시도
    const head = buf.toString("ascii"); // 헤더 영역만 대충 ASCII로 살펴봄
    const m1 = head.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
    const m2 = head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
    charset = (m1?.[1] || m2?.[1] || "").toLowerCase();
  }
  if (/euc-kr|ks_c_5601|cp949/.test(charset)) return "euc-kr";
  if (charset) return charset;
  return "utf-8";
}

/** 상대경로 → 절대경로 보정 */
function absolutize(doc, base) {
  doc.querySelectorAll("[href]").forEach((a) => {
    try {
      const u = new URL(a.getAttribute("href"), base);
      a.setAttribute("href", u.toString());
    } catch {}
  });
  doc.querySelectorAll("[src]").forEach((el) => {
    try {
      const u = new URL(el.getAttribute("src"), base);
      el.setAttribute("src", u.toString());
    } catch {}
  });
}

export default async function handler(req, res) {
  setCors(res);

  // 프리플라이트
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    // 파라미터
    const date = (req.query.date || todayKST()).toString(); // yyyy-mm-dd
    const version = (req.query.d || "k").toString(); // k(개역개정) | w(우리말성경)
    const format = (req.query.format || "json").toString(); // json | html

    // 원본 URL
    const source = `https://www.duranno.com/qt/view/bible.asp?qtDate=${encodeURIComponent(
      date
    )}&d=${encodeURIComponent(version)}`;

    // 페이지 가져오기 (바이너리)
    const upstream = await fetch(source, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);

    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = (upstream.headers.get("content-type") || "").toLowerCase();
    const charset = guessCharset(ct, buf);

    // EUC-KR 등 → UTF-8로 디코딩
    const html = iconv.decode(buf, charset);

    // DOM 파싱
    const dom = new JSDOM(html, { url: source });
    const doc = dom.window.document;

    // 우리가 필요한 영역만 선택
    const bible = doc.querySelector("div.contents.right.last-div .bible");
    if (!bible) {
      res
        .status(404)
        .json({ error: "bible element not found", date, version, source, charset });
      return;
    }

    // 불필요 요소 제거 + 경로 보정
    bible.querySelectorAll("script, noscript").forEach((el) => el.remove());
    absolutize(bible, source);

    // 제목/아멘 수 추출
    const title = doc.querySelector(".font-size h1 em")?.textContent?.trim() || "오늘의 말씀";
    const amenText = doc.querySelector(".amen .red-t")?.textContent || "";
    const amenCount = (() => {
      const n = amenText.replace(/[^\d]/g, "");
      return n ? Number(n) : null;
    })();

    // HTML 조각으로 반환
    if (format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
      // 깔끔한 fragment (스타일은 클라이언트에서 입히는 걸 권장)
      res
        .status(200)
        .send(
          `<div class="qt-fragment" data-date="${date}" data-version="${version}">
  <h3 class="qt-title">${title} <small>(${date})</small></h3>
  ${bible.outerHTML}
</div>`
        );
      return;
    }

    // JSON으로 반환 (클라이언트에서 자유롭게 가공)
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
    res
      .status(200)
      .send(
        JSON.stringify(
          {
            date,
            version,
            title,
            amenCount, // 없으면 null
            html: bible.outerHTML,
            source,
            charset,
          },
          null,
          2
        )
      );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
