/* ================================================================
   data.js — 시트 데이터를 읽고, 모든 화면이 같은 기준으로 쓰는 판단을 한 곳에서 해요
   · 상태 판단 우선순위 (resolveStatus)
   · 어떤 날 어떤 사람이 작업 가능한지 (availability / classify / daySummary)
   · 회의 후보 찾기 (meetingCandidates)
   · 확정 회의 저장소 (Meetings)
   ================================================================ */
(function (global) {
  "use strict";
  const MB = global.MB;
  const CFG = MB.cfg;
  const H = CFG.headers || {};
  const V = CFG.values || {};
  const { norm, isExample, readTable, field, matches, parseDate, parseStamp, parseTimes, subtract, parseCSV, dow, dkey, clock } = MB;

  // ================================================================
  // 1. 시트 불러오기
  // ================================================================
  async function fetchRows(url) {
    const u = norm(url);
    if (!u) return null; // 설정 안 됨
    const res = await fetch(u + (u.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(`시트를 읽지 못했어요 (HTTP ${res.status})`);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("CSV가 아니라 웹페이지가 왔어요. '웹에 게시'에서 CSV로 게시했는지 확인해 주세요.");
    return parseCSV(text);
  }

  async function loadSheets() {
    const S = CFG.sheets || {};
    if (!norm(S.roster)) throw new Error("config.js에 '명단' 탭 주소(sheets.roster)가 없어요.");
    const soft = (p, label, notes) => p.catch((e) => { notes.push(`${label}: ${e.message}`); return null; });
    const notes = [];
    const [roster, weekly, leave, departed] = await Promise.all([
      fetchRows(S.roster),
      fetchRows(S.weekly),
      fetchRows(S.leave),
      soft(fetchRows(S.departed), "빠진 멤버 탭", notes),
    ]);
    return { roster, weekly, leave, departed, notes, departedConfigured: !!norm(S.departed) };
  }

  // ================================================================
  // 2. 사람 목록 만들기 + 상태 판단
  // ================================================================
  const activityOf = (v) => (matches(v, V.longOff || ["장기"]) ? "longoff" : matches(v, V.limited || ["제한"]) ? "limited" : "active");
  const checkModeOf = (v) => (matches(v, V.checkEach || ["일정별"]) ? "each" : matches(v, ["해당 없음", "해당없음"]) ? "none" : "register");

  /**
   * 상태 판단 우선순위 — 모든 화면이 이 함수 하나만 써요.
   *  1) 빠진 멤버      → 명단에서 제외 (build 단계에서 이미 빠짐)
   *  2) 장기 OFF       → longoff  (스케줄 미제출에서 제외)
   *  3) 일정별 확인 필요 → check    (스케줄 미제출에서 제외)
   *  4) 가능 시간 응답 있음 → avail
   *  5) 그 밖에 응답 없음 → nosubmit
   */
  function resolveStatus(p) {
    if (p.left) return "left";
    if (p.activity === "longoff") return "longoff";
    if (p.checkMode === "each") return "check";
    if (p.responded) return "avail";
    return "nosubmit";
  }

  // 휴가·일정 폼의 '종류' (기존 사이트 규칙 그대로)
  const ON_STATE = new Set(["on", "근무", "출근", "추가근무", "추가 근무", "변경"]);
  function leaveKind(v) {
    const t = norm(v).toLowerCase();
    if (t.includes("취소")) return "cancel";
    if (t.includes("다른 시간") || t.includes("일해요") || ON_STATE.has(t)) return "on";
    if (t.includes("몇 시간") || t.includes("빠져")) return "partial";
    return "off";
  }

  function build(raw) {
    const nameH = H.name || ["이름"];

    // 빠진 멤버
    const departed = readTable(raw.departed, nameH)
      .map((o) => ({ name: field(o, nameH), team: field(o, H.team || ["팀"]), date: field(o, H.leftAt || ["날짜"]), memo: field(o, H.memo || ["메모"]) }))
      .filter((x) => x.name && !isExample(x.name));
    const gone = new Set(departed.map((x) => x.name));

    // 명단
    const members = [];
    const byName = new Map();
    for (const o of readTable(raw.roster, nameH)) {
      const name = field(o, nameH);
      if (!name || isExample(name) || byName.has(name)) continue;
      const p = {
        name,
        team: field(o, H.team || ["팀"]),
        activityRaw: field(o, H.activity || ["활동 상태"]),
        checkRaw: field(o, H.checkMode || ["일정 확인 방식"]),
        offStart: parseDate(field(o, H.offStart || ["OFF 시작일"])),
        offEnd: parseDate(field(o, H.offEnd || ["예상 복귀일"])),
        offEndRaw: field(o, H.offEnd || ["예상 복귀일"]),
        memo: field(o, H.memo || ["메모"]),
        left: gone.has(name),
        plans: Array(7).fill(null),
        weeklyMemo: "",
        responded: false,
        respondedAt: 0,
      };
      p.activity = activityOf(p.activityRaw);
      p.checkMode = checkModeOf(p.checkRaw);
      byName.set(name, p);
      if (!p.left) members.push(p);
    }

    // 작업 가능 시간(근무시간 응답): 사람마다 가장 최근 응답만
    const latest = new Map();
    readTable(raw.weekly, nameH).forEach((r, i) => {
      const name = field(r, nameH);
      const p = byName.get(name);
      if (!p || p.left) return;
      const ord = (parseStamp(field(r, H.timestamp || ["타임스탬프"])) || 0) + i / 1000;
      const prev = latest.get(name);
      if (!prev || ord >= prev.ord) latest.set(name, { r, ord });
    });
    for (const [name, { r, ord }] of latest) {
      const p = byName.get(name);
      p.plans = MB.DAY.map((d) => {
        const k = Object.keys(r).find((hd) => hd === d || hd.startsWith(d + "요일"));
        return parseTimes(k ? r[k] : "");
      });
      p.weeklyMemo = field(r, ["메모"]);
      p.responded = true;
      p.respondedAt = ord;
    }

    for (const p of members) p.status = resolveStatus(p);

    // 휴가·일정: 쌓인 응답 전부. '취소'는 같은 사람·같은 시작일의 앞선 일정을 지워요 (기존 규칙)
    const list = [];
    const cancels = [];
    readTable(raw.leave, nameH).forEach((r, i) => {
      const name = field(r, nameH);
      const p = byName.get(name);
      if (!p || p.left) return;
      let s = parseDate(field(r, H.start || ["시작일"]));
      let e = parseDate(field(r, H.end || ["종료일"])) || s;
      if (s == null) return;
      if (e < s) [s, e] = [e, s];
      const ord = (parseStamp(field(r, H.timestamp || ["타임스탬프"])) || 0) + i / 1000;
      const kindRaw = field(r, H.kind || ["종류"]);
      const kind = leaveKind(kindRaw);
      if (kind === "cancel") { cancels.push({ name, s, ord }); return; }
      const timeText = field(r, H.time || ["시간"]);
      const times = norm(timeText) ? parseTimes(timeText) : null;
      const hasTimes = !!(times && times.ranges.length);
      list.push({
        name, s, e, ord,
        kind: kind === "partial" && !hasTimes ? "off" : kind,
        kindLabel: norm(kindRaw) || "휴가·일정",
        times: kind === "off" ? null : times,
        timeText: norm(timeText),
        note: field(r, H.content || ["내용"]),
      });
    });
    const exceptions = list
      .filter((ex) => !cancels.some((c) => c.name === ex.name && c.s === ex.s && c.ord > ex.ord))
      .sort((a, b) => a.s - b.s || a.ord - b.ord);

    const exByName = new Map();
    for (const ex of exceptions) {
      if (!exByName.has(ex.name)) exByName.set(ex.name, []);
      exByName.get(ex.name).push(ex);
    }

    const teams = [...new Set(members.map((p) => p.team).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
    MB.setTeams(teams);

    return {
      members, departed, exceptions, exByName, teams,
      departedConfigured: raw.departedConfigured, notes: raw.notes || [],
    };
  }

  // ================================================================
  // 3. 날짜별 판단 — 모든 화면 공통
  // ================================================================
  let DB = null; // 지금 쓰는 데이터
  const exceptionsOf = (name) => (DB && DB.exByName.get(name)) || [];

  // 그날 걸리는 휴가·일정 중 가장 나중에 낸 것
  function exceptionOn(p, n) {
    let hit = null;
    for (const ex of exceptionsOf(p.name)) if (ex.s <= n && n <= ex.e && (!hit || ex.ord >= hit.ord)) hit = ex;
    return hit;
  }

  /**
   * 어떤 사람이 어떤 날 '자동으로 확인된' 작업 가능 시간
   * null이면 그날 자동 확인된 가능 시간이 없다는 뜻이에요.
   *  how: base(매주 등록) · changed(그날만 다른 시간) · reduced(몇 시간 빠짐) · declared(일정별 확인/미제출이지만 그날 따로 등록)
   */
  function availability(p, n) {
    if (p.status === "longoff" || p.status === "left") return null;
    const ex = exceptionOn(p, n);
    if (ex && ex.kind === "off") return null;
    if (ex && ex.kind === "on") {
      const t = ex.times;
      if (p.status !== "avail") return t && t.ranges.length ? { ranges: t.ranges, unknown: false, how: "declared", ex } : null;
      return { ranges: t ? t.ranges : [], unknown: !t || !t.ranges.length, how: "changed", ex };
    }
    if (p.status !== "avail") return null;
    const base = p.plans[dow(n)];
    if (!base) return null;
    if (ex && ex.kind === "partial" && base.ranges.length) {
      const left = subtract(base.ranges, ex.times.ranges);
      return left.length ? { ranges: left, unknown: false, how: "reduced", ex } : null;
    }
    return { ranges: base.ranges, unknown: base.unknown, how: "base", text: base.text };
  }

  // 그날 휴가·일정(종일 또는 몇 시간 빠짐)
  function leaveOn(p, n) {
    if (p.status === "longoff" || p.status === "left") return null;
    const ex = exceptionOn(p, n);
    return ex && (ex.kind === "off" || ex.kind === "partial") ? ex : null;
  }

  function classify(p, n) {
    if (p.status === "longoff") return "longoff";
    const a = availability(p, n);
    if (a && (a.ranges.length || a.unknown)) return "avail";
    if (leaveOn(p, n)) return "away";
    if (p.status === "check") return "check";
    if (p.status === "nosubmit") return "nosubmit";
    return "rest";
  }

  const firstStart = (a) => (a.ranges.length ? a.ranges[0][0] : 99);

  // 하루 요약: 작업 가능 · 휴가·일정 · 일정별 확인 필요 · 장기 OFF · 미제출 · 쉬는 날
  function daySummary(n, people) {
    const out = { avail: [], leave: [], check: [], longoff: [], nosubmit: [], rest: [] };
    for (const p of people || DB.members) {
      const c = classify(p, n);
      const lv = leaveOn(p, n);
      if (lv) out.leave.push({ p, ex: lv });
      if (c === "avail") out.avail.push({ p, a: availability(p, n) });
      else if (c === "check") out.check.push(p);
      else if (c === "longoff") out.longoff.push(p);
      else if (c === "nosubmit") out.nosubmit.push(p);
      else if (c === "rest") out.rest.push(p);
    }
    out.avail.sort((x, y) => firstStart(x.a) - firstStart(y.a) || x.p.name.localeCompare(y.p.name, "ko"));
    out.leave.sort((x, y) => x.p.name.localeCompare(y.p.name, "ko"));
    return out;
  }

  // 상태별 사람 (날짜와 상관없는 목록)
  function byStatus(status, people) {
    return (people || DB.members).filter((p) => p.status === status).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }

  // 매주 기본 가능 시간을 "월화수 10:00–19:00 · 목금 13:00–22:00" 처럼 묶어요
  function weeklySummary(p) {
    if (!p.responded) return "";
    const groups = [];
    for (let i = 0; i < 7; i++) {
      const b = p.plans[i];
      if (!b) continue;
      const t = b.ranges.length ? MB.ranges(b.ranges) : (b.text || "시간 미정");
      const g = groups.find((x) => x.t === t);
      if (g) g.days.push(i); else groups.push({ t, days: [i] });
    }
    if (!groups.length) return "매주 가능한 요일 없음";
    return groups.map((g) => `${g.days.map((d) => MB.DAY[d]).join("")} ${g.t}`).join(" · ");
  }

  // ================================================================
  // 4. 회의 후보 찾기
  // ================================================================
  /**
   * opts: { from, to (일 번호), days: [0..6], startH, endH, minutes, team, limit }
   * 후보 순위: ① 자동 확인 가능 인원 많은 순 ② 휴가·일정 충돌 적은 순 ③ 추가 확인 필요 적은 순 ④ 이른 날짜·시간
   * 장기 OFF는 대상에서 빼고, 일정별 확인 필요·스케줄 미제출은 '추가 확인 필요'로 따로 세요.
   */
  function meetingCandidates(opts) {
    const L = opts.minutes / 60;
    const pool = DB.members.filter((p) => p.status !== "longoff" && (!opts.team || p.team === opts.team));
    const t0 = MB.now();
    const days = new Set(opts.days && opts.days.length ? opts.days : [0, 1, 2, 3, 4, 5, 6]);
    const all = [];
    for (let n = Math.max(opts.from, t0.day); n <= opts.to; n++) {
      if (!days.has(dow(n))) continue;
      const info = pool.map((p) => ({ p, a: availability(p, n), lv: leaveOn(p, n) }));
      for (let t = opts.startH; t + L <= opts.endH + 1e-9; t += 0.5) {
        if (n === t0.day && t < t0.hour) continue;
        const r = { n, t, L, ok: [], needCheck: [], needSubmit: [], needTime: [], leave: [], no: [], total: pool.length };
        for (const { p, a, lv } of info) {
          if (a && a.ranges.some(([s, e]) => s <= t + 1e-9 && t + L <= e + 1e-9)) r.ok.push(p);
          else if (lv && (lv.kind === "off" || (lv.times && lv.times.ranges.some(([s, e]) => s < t + L && e > t)))) r.leave.push(p);
          else if (p.status === "check") r.needCheck.push(p);
          else if (p.status === "nosubmit") r.needSubmit.push(p);
          else if (a && a.unknown) r.needTime.push(p);
          else r.no.push(p);
        }
        r.need = r.needCheck.length + r.needSubmit.length + r.needTime.length;
        r.hard = r.leave.length + r.no.length;
        if (r.ok.length) all.push(r);
      }
    }
    all.sort((x, y) => y.ok.length - x.ok.length || x.leave.length - y.leave.length || x.need - y.need
      || x.n - y.n || (x.t % 1 === 0 ? 0 : 1) - (y.t % 1 === 0 ? 0 : 1) || x.t - y.t);

    // 비슷한 후보는 빼요: 같은 날이면 2시간 이상 떨어진 것만, 하루에 최대 2개
    const picked = [];
    const perDay = new Map();
    for (const r of all) {
      if (picked.length >= (opts.limit || 5)) break;
      if ((perDay.get(r.n) || 0) >= 2) continue;
      if (picked.some((q) => q.n === r.n && Math.abs(q.t - r.t) < Math.max(L + 1, 2))) continue;
      picked.push(r);
      perDay.set(r.n, (perDay.get(r.n) || 0) + 1);
    }
    return { list: picked, pool, searched: all.length };
  }

  // ================================================================
  // 5. 확정 회의 저장소
  //    Apps Script 주소가 있으면 시트 '회의 확정' 탭에 저장(모두 공유),
  //    없으면 이 기기 브라우저에만 저장해요.
  // ================================================================
  const LS_KEY = "metro-board-meetings-v2";
  const MH = {
    id: ["회의 ID"], title: ["회의명"], team: ["대상 팀"], date: ["날짜"], start: ["시작 시간", "시작"], end: ["종료 시간", "종료"],
    at: ["확정 시각"], ok: ["참석 가능 인원"], need: ["추가 확인 필요 인원"], memo: ["메모"], status: ["상태"],
  };

  function normMeeting(o) {
    const d = parseDate(field(o, MH.date));
    const s = MB.parseClock(field(o, MH.start));
    let e = MB.parseClock(field(o, MH.end));
    if (d == null || s == null) return null;
    if (e == null) e = s + 1;
    if (e <= s) e += 24;
    const st = field(o, MH.status);
    return {
      id: field(o, MH.id) || `${dkey(d)}-${s}`,
      title: field(o, MH.title) || "회의",
      team: field(o, MH.team) || "전체",
      n: d, date: dkey(d), start: s, end: e,
      at: field(o, MH.at), ok: field(o, MH.ok), need: field(o, MH.need), memo: field(o, MH.memo),
      status: /취소/.test(st) ? "취소" : /완료/.test(st) ? "완료" : "예정",
    };
  }
  // 시트 한 줄 모양으로 (Apps Script·로컬 공통)
  function toRow(m) {
    return {
      "회의 ID": m.id, "회의명": m.title, "대상 팀": m.team, "날짜": m.date,
      "시작 시간": clock(m.start), "종료 시간": clock(m.end),
      "확정 시각": m.at, "참석 가능 인원": m.ok, "추가 확인 필요 인원": m.need, "메모": m.memo, "상태": m.status,
    };
  }

  const Meetings = {
    list: [],
    mode: norm(CFG.meetingApi) ? "api" : "local",
    error: "",
    async load() {
      this.error = "";
      try {
        if (this.mode === "api") {
          const res = await fetch(norm(CFG.meetingApi) + "?action=list&_=" + Date.now(), { cache: "no-store" });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || "회의 목록을 못 읽었어요");
          this.list = (j.meetings || []).map(normMeeting).filter(Boolean);
        } else {
          let rows = [];
          if (norm((CFG.sheets || {}).meetings)) {
            const csv = await fetchRows(CFG.sheets.meetings);
            rows = readTable(csv, MH.id.concat(MH.date)).map(normMeeting).filter(Boolean).map((m) => ({ ...m, shared: true }));
          }
          const local = readLocal().map(normMeeting).filter(Boolean).map((m) => ({ ...m, local: true }));
          this.list = rows.concat(local);
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
      this.list.sort((a, b) => a.n - b.n || a.start - b.start);
      return this.list;
    },
    on(n) { return this.list.filter((m) => m.n === n && m.status !== "취소"); },
    async create(m, pass) {
      const row = toRow(m);
      if (this.mode === "api") return this._post({ action: "create", pass, meeting: row });
      const all = readLocal(); all.push(row); writeLocal(all);
      await this.load(); return { ok: true };
    },
    async setStatus(id, status, pass) {
      if (this.mode === "api") return this._post({ action: "status", pass, id, status });
      const all = readLocal().map((r) => (r["회의 ID"] === id ? { ...r, "상태": status } : r));
      writeLocal(all);
      await this.load(); return { ok: true };
    },
    async checkPass(pass) {
      if (this.mode !== "api") return { ok: true };
      return this._post({ action: "auth", pass }, true);
    },
    async _post(body, noReload) {
      // text/plain으로 보내야 Apps Script가 사전 요청 없이 받아요
      const res = await fetch(norm(CFG.meetingApi), { method: "POST", body: JSON.stringify(body) });
      const j = await res.json();
      if (!j.ok) return { ok: false, error: j.error || "저장하지 못했어요" };
      if (!noReload) {
        if (j.meetings) { this.list = j.meetings.map(normMeeting).filter(Boolean).sort((a, b) => a.n - b.n || a.start - b.start); }
        else await this.load();
      }
      return { ok: true };
    },
  };
  function readLocal() { try { const v = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function writeLocal(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (e) { /* 저장 공간이 없으면 조용히 넘어가요 */ } }

  // 확정 시각 (한국 시간 문자열)
  function stampNow() {
    const t = MB.now();
    return `${dkey(t.day)} ${MB.pad(t.hh)}:${MB.pad(t.mm)}`;
  }

  // ================================================================
  Object.assign(MB, {
    loadSheets, build, resolveStatus,
    setDB: (db) => { DB = db; }, getDB: () => DB,
    availability, leaveOn, classify, daySummary, byStatus, weeklySummary, exceptionOn,
    meetingCandidates, Meetings, stampNow, normMeeting, toRow,
  });
})(typeof window !== "undefined" ? window : globalThis);
