/* ================================================================
   core.js — 모든 화면이 같이 쓰는 기본 도구
   날짜(한국 시간) · 시간 · CSV · 시트 헤더 찾기 · 화면 요소 만들기 · 팀 색상 · 상태 이름
   ================================================================ */
(function (global) {
  "use strict";
  const CFG = global.METRO_CONFIG || {};
  const TZ = CFG.timeZone || "Asia/Seoul";
  const MB = (global.MB = global.MB || {});
  MB.cfg = CFG;

  const DAY = ["월", "화", "수", "목", "금", "토", "일"];
  const DAY_FULL = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"];
  const pad = (n) => String(n).padStart(2, "0");
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const squash = (s) => norm(s).replace(/\s/g, "").toLowerCase();
  const isExample = (name) => /^\(?예시\)?/.test(norm(name));

  // ---------- 날짜: 하루를 '일 번호'(정수)로 다뤄요. 기기 시간대와 상관없이 한국 날짜 기준 ----------
  const dnum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 864e5);
  const dparts = (n) => { const t = new Date(n * 864e5); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
  const dow = (n) => (new Date(n * 864e5).getUTCDay() + 6) % 7; // 월=0 … 일=6
  const dkey = (n) => { const p = dparts(n); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  const weekStart = (n) => n - dow(n);
  const monthStart = (n) => { const p = dparts(n); return dnum(p.y, p.m, 1); };
  const monthEnd = (n) => { const p = dparts(n); return dnum(p.y, p.m + 1, 1) - 1; };
  const addMonths = (n, k) => { const p = dparts(n); return dnum(p.y, p.m + k, 1); };

  const tzFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  function now() {
    const o = {};
    for (const x of tzFmt.formatToParts(new Date())) o[x.type] = x.value;
    const hh = (+o.hour) % 24, mm = +o.minute;
    return { day: dnum(+o.year, +o.month, +o.day), hour: hh + mm / 60, hh, mm };
  }
  const today = () => now().day;

  const dLong = (n) => { const p = dparts(n); return `${p.m}월 ${p.d}일 ${DAY_FULL[dow(n)]}`; };
  const dShort = (n) => { const p = dparts(n); return `${p.m}/${p.d}(${DAY[dow(n)]})`; };
  const dMD = (n) => { const p = dparts(n); return `${p.m}/${p.d}`; };
  const dMonth = (n) => { const p = dparts(n); return `${p.y}년 ${p.m}월`; };
  const dSpan = (a, b) => (a === b ? dShort(a) : `${dShort(a)} – ${dShort(b)}`);

  // 시트 날짜 읽기: "2026-09-28", "2026. 9. 28", "9/28/2026", "26.9.28"
  function parseDate(s) {
    const nums = norm(s).match(/\d+/g);
    if (!nums || nums.length < 3) return null;
    let y, m, d;
    if (nums[0].length === 4) [y, m, d] = nums;
    else if (nums[2].length === 4) [m, d, y] = nums;
    else { y = "20" + nums[0]; m = nums[1]; d = nums[2]; }
    y = +y; m = +m; d = +d;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const n = dnum(y, m, d);
    return dparts(n).m === m ? n : null;
  }

  // 폼 '타임스탬프' 읽기 (순서 비교용): "2026. 9. 18 오후 2:20:15", "9/18/2026 14:20:15"
  function parseStamp(v) {
    const t = norm(v);
    const n = t.match(/\d+/g);
    if (!n || n.length < 5) return 0;
    let [a, b, c, h, mi, se = 0] = n.map(Number);
    let y, mo, d;
    if (n[0].length === 4) [y, mo, d] = [a, b, c]; else [mo, d, y] = [a, b, c];
    if (/오후|pm/i.test(t) && h < 12) h += 12;
    if (/오전|am/i.test(t) && h === 12) h = 0;
    return dnum(y, mo, d) * 86400 + h * 3600 + mi * 60 + se;
  }

  // ---------- 시간 ----------
  // 13.5 → "13:30", 24 → "24:00", 26 → "익일 02:00"
  function clock(x) {
    if (x > 24) return "익일 " + clock(x - 24);
    const h = Math.floor(x + 1e-9), m = Math.round((x - h) * 60);
    return `${pad(h)}:${pad(m)}`;
  }
  const range = ([s, e]) => `${clock(s)}–${clock(e)}`;
  const ranges = (rs) => rs.map(range).join(" / ");

  const OFF_WORDS = new Set(["", "off", "휴무", "쉼", "휴", "x", "-", "×", "없음", "불가"]);
  const ON_WORDS = new Set(["on", "o", "근무", "출근", "가능", "○", "v", "✓", "✔"]);
  const NAMED_TIMES = { "오전": [9, 12], "오후": [13, 18], "저녁": [18, 22], "밤": [20, 24], "새벽": [0, 5] };

  // "10-16", "13:30-18", "10시-16시", "10-12, 14-18", "22-02"(익일 2시까지)
  function parseTimes(v) {
    const text = norm(v);
    const low = text.toLowerCase();
    if (OFF_WORDS.has(low)) return null;
    if (ON_WORDS.has(low)) return { ranges: [], unknown: true, text: "" };
    const asDate = text.match(/^\d{4}[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?$/);
    if (asDate && +asDate[1] <= 24 && +asDate[2] <= 24) return fromRanges([[+asDate[1], +asDate[2]]], text);
    const t = text
      .replace(/(\d+)\s*시\s*(\d+)\s*분/g, "$1:$2")
      .replace(/(\d+)\s*시\s*반/g, "$1:30")
      .replace(/(\d+)\s*시/g, "$1")
      .replace(/[~–—〜]/g, "-");
    const raw = [];
    const re = /(\d{1,2})(?:[:.](\d{2}))?\s*-\s*(\d{1,2})(?:[:.](\d{2}))?/g;
    let m;
    while ((m = re.exec(t))) raw.push([+m[1] + (m[2] ? +m[2] / 60 : 0), +m[3] + (m[4] ? +m[4] / 60 : 0)]);
    if (!raw.length) for (const [w, r] of Object.entries(NAMED_TIMES)) if (text.includes(w)) raw.push(r.slice());
    return fromRanges(raw, text);
  }
  function fromRanges(raw, text) {
    const rs = raw
      .filter(([s, e]) => s <= 24 && e <= 24)
      .map(([s, e]) => (e <= s ? [s, e + 24] : [s, e]))
      .sort((a, b) => a[0] - b[0]);
    return { ranges: rs, unknown: !rs.length, text };
  }
  function subtract(rs, cuts) {
    let out = rs;
    for (const [cs, ce] of cuts) {
      out = out.flatMap(([s, e]) => (ce <= s || cs >= e) ? [[s, e]] : [...(cs > s ? [[s, cs]] : []), ...(ce < e ? [[ce, e]] : [])]);
    }
    return out;
  }
  // "20:00", "20:00:00", "오후 8:00:00", "익일 02:00" → 20, 20, 20, 26
  function parseClock(v) {
    const t = norm(v);
    const m = t.match(/(\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    let h = +m[1];
    const mi = m[2] ? +m[2] : 0;
    if (/오후|pm/i.test(t) && h < 12) h += 12;
    if (/오전|am/i.test(t) && h === 12) h = 0;
    if (/익일/.test(t)) h += 24;
    return h + mi / 60;
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // 헤더 줄을 찾아 { 헤더: 값 } 목록으로 바꿔요. 열 번호에 기대지 않아요.
  function readTable(rows, idHeaders) {
    if (!rows || !rows.length) return [];
    const ids = idHeaders.map(norm);
    const hi = rows.findIndex((r) => r.some((c) => ids.includes(norm(c))));
    if (hi < 0) return [];
    const head = rows[hi].map(norm);
    return rows.slice(hi + 1).map((r) => {
      const o = {};
      head.forEach((hd, i) => { if (hd && !(hd in o)) o[hd] = norm(r[i]); });
      return o;
    });
  }
  // 정확히 같은 헤더를 먼저, 없으면 그 낱말이 들어간 헤더를 찾아요
  function field(o, names) {
    for (const n of names) if (n in o) return o[n];
    const keys = Object.keys(o);
    for (const n of names) { const k = keys.find((x) => x.includes(n)); if (k) return o[k]; }
    return "";
  }
  const matches = (v, words) => { const s = squash(v); return !!s && words.some((w) => s.includes(squash(w))); };

  // ---------- 화면 요소 만들기 (시트 글자는 항상 텍스트로만 넣어요 → XSS 방지) ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "vars") for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const c of [kids].flat(Infinity)) {
      if (c == null || c === false || c === "") continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "ic" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    const u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#i-" + name);
    s.append(u);
    return s;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  // 비우고 채우기 (빈 값·배열을 알아서 걸러요. 기본 append는 null을 "null" 글자로 넣어버려요)
  const fill = (el, ...kids) => append(clear(el), kids);

  // ---------- 팀 색상: 팀 이름을 코드에 적지 않고, 시트에 나온 팀들에 차분한 색을 차례로 붙여요 ----------
  const PALETTE = ["#4F6FA8", "#B0587A", "#8A7E36", "#9A5F3D", "#4E7890", "#7F6A97", "#A3894A", "#5E7A55", "#A05A5A", "#5B6C8F"];
  let teamIdx = new Map();
  function setTeams(list) {
    teamIdx = new Map([...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")).map((t, i) => [t, i]));
  }
  function teamColor(t) {
    const c = CFG.teamColors && CFG.teamColors[t];
    if (c && /^#[0-9a-f]{3,8}$/i.test(c)) return c;
    if (!t) return "#8A94A0";
    if (teamIdx.has(t)) return PALETTE[teamIdx.get(t) % PALETTE.length];
    let x = 0; for (const ch of t) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[x % PALETTE.length];
  }

  // ---------- 상태 이름·아이콘 (모든 화면 공통) ----------
  const STATUS = {
    avail:    { label: "가능 시간 등록",   icon: "ok",    tone: "ok" },
    check:    { label: "일정별 확인 필요", icon: "help",  tone: "check" },
    longoff:  { label: "장기 OFF",        icon: "pause", tone: "off" },
    nosubmit: { label: "스케줄 미제출",    icon: "alert", tone: "miss" },
    leave:    { label: "휴가·일정",       icon: "leave", tone: "leave" },
  };
  const ACTIVITY = { active: "활동 중", limited: "제한적 활동", longoff: "장기 OFF" };

  Object.assign(MB, {
    DAY, DAY_FULL, pad, norm, squash, isExample,
    dnum, dparts, dow, dkey, weekStart, monthStart, monthEnd, addMonths, now, today,
    dLong, dShort, dMD, dMonth, dSpan, parseDate, parseStamp,
    clock, range, ranges, parseTimes, subtract, parseClock,
    parseCSV, readTable, field, matches,
    h, append, icon, clear, fill,
    setTeams, teamColor, STATUS, ACTIVITY,
  });
})(typeof window !== "undefined" ? window : globalThis);
