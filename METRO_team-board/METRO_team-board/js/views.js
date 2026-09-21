/* ================================================================
   views.js — 다섯 화면(오늘 · 주간 · 월간 · 회의 · 팀 명단)
   판단은 모두 data.js 함수를 쓰고, 여기서는 보여주기만 해요.
   ================================================================ */
(function (global) {
  "use strict";
  const MB = global.MB;
  const { h, icon, clear, fill, STATUS, ACTIVITY } = MB;
  const CFG = MB.cfg;
  const MD = CFG.meetingDefaults || {};

  const PASS_KEY = "metro-board-pass";
  const ui = (MB.ui = {
    week: { start: null, sel: null },
    month: { start: null, sel: null },
    meet: {
      title: MD.title || "정기회의", team: "", minutes: MD.minutes || 60, period: MD.period || "2w",
      from: null, to: null, days: [0, 1, 2, 3, 4, 5, 6], startH: MD.fromHour ?? 10, endH: MD.toHour ?? 24,
      open: null, busy: false, msg: "", flash: "",
      pass: (() => { try { return sessionStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; } })(),
    },
    team: { q: "", team: "", status: "all" },
  });
  const go = (view) => { if (location.hash !== "#" + view) location.hash = view; else MB.render(); };

  // ================================================================
  // 작은 부품
  // ================================================================
  const teamDot = (team) => h("span", { class: "dot", vars: { "--c": MB.teamColor(team) }, "aria-hidden": "true" });
  const toneOf = (kind) => "tone-" + STATUS[kind].tone;
  function badge(kind, text) {
    const s = STATUS[kind];
    return h("span", { class: `badge tone-${s.tone}` }, icon(s.icon), text || s.label);
  }
  function pageHead(title, sub, extra) {
    return h("div", { class: "page-head" },
      h("div", null, h("h1", { class: "page-title" }, title), sub ? h("p", { class: "page-sub" }, sub) : null),
      extra);
  }
  function secHead(id, title, count, extra, ic, tone) {
    return h("div", { class: "sec__head", id: id ? id + "-h" : null },
      h("h2", { class: "sec__title" + (tone ? " " + tone : ""), id },
        ic ? icon(ic) : null, title, count != null ? h("span", { class: "count" }, `${count}명`) : null),
      extra);
  }
  const emptyLine = (text, ic) => h("p", { class: "empty" }, icon(ic || "info"), text);
  const list = (items, empty) => (items.length ? h("ul", { class: "rows" }, items) : emptyLine(empty));

  function personRow({ p, sub, side, tags, cls }) {
    return h("li", null, h("div", { class: "row" + (cls ? " " + cls : "") },
      teamDot(p.team),
      h("div", { class: "row__main" },
        h("div", { class: "row__title" },
          h("span", { class: "row__name" }, p.name),
          p.team ? h("span", { class: "row__team" }, p.team) : null,
          tags),
        sub ? h("div", { class: "row__sub" }, sub) : null),
      side != null ? h("div", { class: "row__side" }, side) : h("span")));
  }

  const timeSide = (a) => (a.unknown || !a.ranges.length
    ? h("span", { class: "muted" }, "시간 미정")
    : a.ranges.map((r) => h("span", null, MB.range(r))));

  function availTags(p, a, n) {
    const t = [];
    const now = MB.now();
    if (n === now.day && a.ranges.some(([s, e]) => s <= now.hour && now.hour < e)) t.push(h("span", { class: "tag tag--now" }, "지금"));
    if (a.how === "changed") t.push(h("span", { class: "tag" }, "그날만 변경"));
    if (a.how === "reduced") t.push(h("span", { class: "tag" }, "일부 빠짐"));
    if (a.how === "declared") t.push(h("span", { class: "tag" }, "개별 등록"));
    if (p.activity === "limited") t.push(h("span", { class: "tag" }, "제한적 활동"));
    return t;
  }
  function availRow(p, a, n) {
    const note = (a.ex && (a.ex.note || "")) || (a.unknown ? p.weeklyMemo : "");
    return personRow({ p, side: timeSide(a), tags: availTags(p, a, n), sub: note || null });
  }

  function leaveRow(p, ex, showSpan) {
    const bits = [];
    if (showSpan || ex.s !== ex.e) bits.push(MB.dSpan(ex.s, ex.e));
    if (ex.note) bits.push(ex.note);
    return personRow({
      p,
      side: ex.kind === "partial" && ex.times ? ex.times.ranges.map((r) => h("span", null, MB.range(r))) : h("span", { class: "muted" }, "종일"),
      tags: ex.kind === "partial" ? h("span", { class: "tag" }, "일부 시간") : null,
      sub: bits.length ? bits.join(" · ") : null,
    });
  }

  // 장기 OFF 설명: "10/15 복귀 예정" · "복귀일 미정"
  function offInfo(p) {
    const t = MB.today();
    const parts = [];
    if (p.offEnd != null) parts.push(p.offEnd < t ? `복귀 예정일 지남(${MB.dMD(p.offEnd)})` : `${MB.dMD(p.offEnd)} 복귀 예정`);
    else parts.push(MB.norm(p.offEndRaw) || "복귀일 미정");
    if (p.memo && !parts.includes(p.memo)) parts.push(p.memo);
    return parts.join(" · ");
  }
  const offPeriod = (p) => (p.offStart != null ? `${MB.dMD(p.offStart)}부터` + (p.offEnd != null ? ` ${MB.dMD(p.offEnd)}까지` : "") : "");

  function meetingRow(m, withDate) {
    const when = (withDate ? MB.dShort(m.n) + " " : "") + MB.range([m.start, m.end]);
    return h("li", null, h("div", { class: "row row--meet" },
      h("span", { class: "dot", vars: { "--c": "var(--brand)" }, "aria-hidden": "true" }),
      h("div", { class: "row__main" },
        h("div", { class: "row__title" }, icon("flag"), h("span", { class: "row__name" }, m.title),
          h("span", { class: "row__team" }, m.team || "전체")),
        m.memo ? h("div", { class: "row__sub" }, m.memo) : null),
      h("div", { class: "row__side" }, h("span", null, when))));
  }

  function stat({ tone, ic, label, num, onclick, lead, pressed }) {
    return h("button", {
      type: "button", class: "stat " + (tone || "") + (lead ? " stat--lead" : ""), onclick,
      "aria-pressed": pressed == null ? null : String(!!pressed),
      "aria-label": `${label} ${num}명`,
    },
      h("span", { class: "stat__label" }, ic ? icon(ic) : null, label),
      h("span", { class: "stat__num" }, String(num), h("small", null, "명")));
  }

  const scrollToId = (id) => { const el = document.getElementById(id); if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); const f = el.querySelector("h2,h3"); if (f) { f.setAttribute("tabindex", "-1"); f.focus({ preventScroll: true }); } } };
  const namesLine = (arr, max) => {
    const n = arr.map((p) => p.name);
    return n.length > max ? `${n.slice(0, max).join(", ")} 외 ${n.length - max}명` : n.join(", ");
  };

  // ================================================================
  // 1. 오늘
  // ================================================================
  function special(kind, people, max) {
    const s = STATUS[kind];
    const why = { check: "고정 시간 대신 일정마다 따로 물어봐야 해요", longoff: "당분간 일정 계산에서 빠져 있어요", nosubmit: "작업 가능 시간 폼을 아직 안 냈어요" }[kind];
    const shown = people.slice(0, max);
    return h("section", { class: "group " + toneOf(kind), id: "g-" + kind, "aria-labelledby": "g-" + kind + "-t" },
      h("div", { class: "group__head" },
        h("h3", { id: "g-" + kind + "-t" }, icon(s.icon), s.label),
        h("span", { class: "count" }, `${people.length}명`)),
      h("p", { class: "group__why" }, why),
      people.length
        ? h("ul", { class: "names" },
            shown.map((p) => h("li", null, p.name, h("small", null, kind === "longoff" ? offInfo(p) : p.team))),
            people.length > max ? h("li", { class: "more" }, `외 ${people.length - max}명`) : null)
        : h("p", { class: "empty", style: "padding:10px 0 0" }, icon("ok"), "없어요"),
      people.length > max
        ? h("a", { class: "more-link", href: "#team", onclick: () => { ui.team.status = kind; } }, "팀 명단에서 전체 보기", icon("chev"))
        : null);
  }

  function renderToday(root) {
    const n = MB.today();
    const d = MB.daySummary(n);
    const check = MB.byStatus("check"), longoff = MB.byStatus("longoff"), nosub = MB.byStatus("nosubmit");
    const mts = MB.Meetings.on(n);
    const now = MB.now();
    const workingNow = d.avail.filter(({ a }) => a.ranges.some(([s, e]) => s <= now.hour && now.hour < e)).length;

    fill(root, 
      pageHead("오늘의 팀 상황", MB.dLong(n) + (d.avail.length ? ` · 지금 작업 중 ${workingNow}명` : "")),
      h("div", { class: "summary summary--today" },
        stat({ tone: "tone-ok", ic: "ok", label: "작업 가능", num: d.avail.length, lead: true, onclick: () => scrollToId("s-avail") }),
        stat({ tone: "tone-leave", ic: "leave", label: "휴가·일정", num: d.leave.length, onclick: () => scrollToId("s-leave") }),
        stat({ tone: "tone-check", ic: "help", label: "일정별 확인 필요", num: check.length, onclick: () => scrollToId("g-check") }),
        stat({ tone: "tone-off", ic: "pause", label: "장기 OFF", num: longoff.length, onclick: () => scrollToId("g-longoff") }),
        stat({ tone: "tone-miss", ic: "alert", label: "스케줄 미제출", num: nosub.length, onclick: () => scrollToId("g-nosubmit") })),

      mts.length ? h("section", { class: "sec" },
        secHead("s-meet", "오늘 회의", null, h("a", { class: "more-link", href: "#meet" }, "회의 화면", icon("chev")), "flag"),
        h("div", { class: "panel" }, h("ul", { class: "rows" }, mts.map((m) => meetingRow(m, false))))) : null,

      h("section", { class: "sec", "aria-labelledby": "s-avail" },
        secHead("s-avail", "오늘 작업 가능", d.avail.length, h("span", { class: "sec__note" }, "시작 시간 순"), "ok", "tone-ok"),
        h("div", { class: "panel" }, list(d.avail.map(({ p, a }) => availRow(p, a, n)), "오늘 작업 가능 시간이 등록된 사람이 없어요."))),

      h("section", { class: "sec", "aria-labelledby": "s-leave" },
        secHead("s-leave", "오늘 휴가·일정", d.leave.length, null, "leave", "tone-leave"),
        h("div", { class: "panel" }, list(d.leave.map(({ p, ex }) => leaveRow(p, ex, false)), "오늘 휴가나 개인 일정이 있는 사람은 없어요."))),

      h("section", { class: "sec", "aria-labelledby": "s-special" },
        secHead("s-special", "별도 확인이 필요한 사람", null, h("a", { class: "more-link", href: "#team" }, "팀 명단", icon("chev"))),
        h("div", { class: "groups" }, special("check", check, 5), special("longoff", longoff, 5), special("nosubmit", nosub, 5))),
    );
  }

  // ================================================================
  // 2. 주간
  // ================================================================
  function pager(label, onPrev, onThis, onNext, thisLabel, prevLabel, nextLabel, fk) {
    return h("div", { class: "pager" },
      h("button", { type: "button", class: "iconbtn", "aria-label": prevLabel, onclick: onPrev, dataset: { fk: fk + "-prev" } }, icon("left")),
      h("span", { class: "pager__label", "aria-live": "polite" }, label),
      h("button", { type: "button", class: "iconbtn", "aria-label": nextLabel, onclick: onNext, dataset: { fk: fk + "-next" } }, icon("right")),
      h("button", { type: "button", class: "btn btn--sm", onclick: onThis, dataset: { fk: fk + "-this" } }, thisLabel));
  }

  function onceNotice(longoff, nosub) {
    if (!longoff.length && !nosub.length) return null;
    return h("p", { class: "notice" },
      longoff.length ? h("span", { class: "tone-off" }, icon("pause"), h("b", null, `장기 OFF ${longoff.length}명`),
        longoff.map((p) => `${p.name}(${offInfo(p)})`).join(", ")) : null,
      nosub.length ? h("span", { class: "tone-miss" }, icon("alert"), h("b", null, `스케줄 미제출 ${nosub.length}명`), namesLine(nosub, 6)) : null);
  }

  function renderWeek(root) {
    const t = MB.today();
    const W = ui.week;
    if (W.start == null) W.start = MB.weekStart(t);
    if (W.sel == null || W.sel < W.start || W.sel > W.start + 6) W.sel = t >= W.start && t <= W.start + 6 ? t : W.start;
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => W.start + i);
    const sums = days.map((n) => MB.daySummary(n));
    const move = (k) => () => { W.start += 7 * k; W.sel = null; MB.render(); };

    const strip = h("div", { class: "strip", role: "group", "aria-label": "날짜 고르기" },
      days.map((n, i) => h("button", {
        type: "button", class: (n === t ? "is-today " : "") + (i === 6 ? "is-sun" : ""),
        "aria-selected": String(n === W.sel), "aria-pressed": String(n === W.sel),
        "aria-label": `${MB.dLong(n)}${n === t ? " 오늘" : ""}, 작업 가능 ${sums[i].avail.length}명`,
        dataset: { fk: "wd-" + i },
        onclick: () => { W.sel = n; MB.render(); },
      },
        h("span", { class: "s-dow" }, n === t ? "오늘" : MB.DAY[i]),
        h("span", { class: "s-date" }, String(MB.dparts(n).d)),
        h("span", { class: "s-cnt" }, `${sums[i].avail.length}명`))));

    const cols = h("div", { class: "wcols" }, days.map((n, i) => {
      const s = sums[i];
      const mts = MB.Meetings.on(n);
      return h("section", { class: "wcol panel" + (n === W.sel ? " is-sel" : "") + (n === t ? " is-today" : ""), "aria-label": MB.dLong(n) },
        h("div", { class: "wcol__head" },
          h("h3", null, `${MB.DAY[i]} ${MB.dMD(n)}`, n === t ? h("span", { class: "today-mark" }, "오늘") : null),
          h("span", { class: "count" }, `작업 가능 ${s.avail.length}명`)),
        mts.length ? h("ul", { class: "rows" }, mts.map((m) => meetingRow(m, false))) : null,
        s.avail.length ? h("ul", { class: "rows" }, s.avail.map(({ p, a }) => availRow(p, a, n))) : emptyLine("작업 가능 시간이 등록된 사람이 없어요."),
        s.leave.length ? h("div", { class: "wcol__part tone-leave" },
          h("h4", null, icon("leave"), `휴가·일정 ${s.leave.length}명`),
          h("ul", { class: "rows" }, s.leave.map(({ p, ex }) => leaveRow(p, ex, false)))) : null,
        s.check.length ? h("div", { class: "wcol__part tone-check" },
          h("h4", null, icon("help"), `일정별 확인 필요 ${s.check.length}명`),
          h("p", { class: "plain" }, s.check.map((p) => p.name).join(", "))) : null);
    }));

    // 이번 주 회의 후보 (참고)
    const cand = MB.meetingCandidates({ from: W.start, to: W.start + 6, days: [], startH: MD.fromHour ?? 10, endH: MD.toHour ?? 24, minutes: MD.minutes || 60, team: "", limit: 3 });

    fill(root, 
      pageHead("주간", `${MB.dLong(W.start)} – ${MB.dLong(W.start + 6)}`,
        pager(`${MB.dMD(W.start)} – ${MB.dMD(W.start + 6)}`, move(-1), () => { W.start = MB.weekStart(t); W.sel = t; MB.render(); }, move(1), "이번 주", "이전 주", "다음 주", "wk")),
      onceNotice(MB.byStatus("longoff"), MB.byStatus("nosubmit")),
      strip,
      cols,
      h("section", { class: "sec", "aria-labelledby": "s-wcand" },
        secHead("s-wcand", "이 주의 회의 후보", null, h("span", { class: "sec__note" }, `${MD.minutes || 60}분 기준 · 참고용`), "meet"),
        h("div", { class: "panel" },
          cand.list.length ? h("ul", { class: "rows" }, cand.list.map((r) => h("li", null, h("div", { class: "row" },
            h("span", { class: "dot", vars: { "--c": "var(--ok)" }, "aria-hidden": "true" }),
            h("div", { class: "row__main" },
              h("div", { class: "row__title" }, h("span", { class: "row__name" }, `${MB.DAY_FULL[MB.dow(r.n)]} ${MB.dMD(r.n)} ${MB.clock(r.t)}`)),
              h("div", { class: "row__sub" }, `등록 인원 ${r.total}명 중 · 추가 확인 ${r.need}명 · 참여 어려움 ${r.hard}명`)),
            h("div", { class: "row__side" }, h("span", null, `${r.ok.length}명 가능`))))))
            : emptyLine("이 주에는 함께 비는 시간이 없어요."),
          h("div", { style: "padding:4px 16px 8px" },
            h("a", { class: "more-link", href: "#meet", onclick: () => { Object.assign(ui.meet, { period: "custom", from: Math.max(W.start, t), to: W.start + 6, open: null }); } },
              "회의 화면에서 비교하고 확정하기", icon("chev"))))),
    );
  }

  // ================================================================
  // 3. 월간 — 휴가·기간 일정과 확정 회의만
  // ================================================================
  function renderMonth(root) {
    const t = MB.today();
    const M = ui.month;
    if (M.start == null) M.start = MB.monthStart(t);
    const ms = M.start, me = MB.monthEnd(ms);
    if (M.sel == null || M.sel < ms || M.sel > me) M.sel = t >= ms && t <= me ? t : ms;
    const move = (k) => () => { M.start = MB.addMonths(M.start, k); M.sel = null; MB.render(); };
    const first = MB.weekStart(ms), last = MB.weekStart(me) + 6;

    const cells = [];
    MB.DAY.forEach((d, i) => cells.push(h("div", { class: "cal__dow" + (i === 6 ? " is-sun" : ""), "aria-hidden": "true" }, d)));
    for (let n = first; n <= last; n++) {
      const lv = MB.daySummary(n).leave.length;
      const mt = MB.Meetings.on(n).length;
      const out = n < ms || n > me;
      cells.push(h("button", {
        type: "button",
        class: "cal__day" + (out ? " is-out" : "") + (n === t ? " is-today" : "") + (MB.dow(n) === 6 ? " is-sun" : ""),
        "aria-pressed": String(n === M.sel),
        "aria-label": `${MB.dLong(n)}${n === t ? ", 오늘" : ""}${lv ? `, 휴가·일정 ${lv}명` : ""}${mt ? `, 확정 회의 ${mt}개` : ""}`,
        dataset: { fk: "cd-" + n },
        onclick: () => { M.sel = n; if (out) M.start = MB.monthStart(n); MB.render(); },
      },
        h("span", { class: "cal__num" }, String(MB.dparts(n).d)),
        mt ? h("span", { class: "cal__flag" }, icon("flag")) : null,
        h("span", { class: "cal__marks" }, lv ? [h("i", { class: "pip" }), String(lv)] : null)));
    }

    const ds = MB.daySummary(M.sel);
    const dm = MB.Meetings.on(M.sel);
    const detail = h("section", { class: "panel detail", "aria-live": "polite", "aria-labelledby": "m-detail" },
      h("div", { class: "detail__head" }, h("h3", { id: "m-detail" }, MB.dLong(M.sel) + (M.sel === t ? " (오늘)" : ""))),
      dm.length ? h("ul", { class: "rows" }, dm.map((m) => meetingRow(m, false))) : null,
      ds.leave.length ? h("ul", { class: "rows" }, ds.leave.map(({ p, ex }) => leaveRow(p, ex, true)))
        : (!dm.length ? emptyLine("이날은 휴가·일정이나 확정된 회의가 없어요.") : null));

    // 이달의 휴가·일정 목록
    const db = MB.getDB();
    const inMonth = db.exceptions.filter((ex) => (ex.kind === "off" || ex.kind === "partial") && ex.e >= ms && ex.s <= me);
    const member = new Map(db.members.map((p) => [p.name, p]));
    const rows = inMonth.filter((ex) => member.has(ex.name) && member.get(ex.name).status !== "longoff").map((ex) => {
      const p = member.get(ex.name);
      const dd = ex.s - t;
      const tag = ex.e < t ? "지남" : dd <= 0 ? "진행 중" : `D-${dd}`;
      return personRow({
        p,
        tags: [h("span", { class: "tag" + (tag === "진행 중" ? " tag--now" : "") }, tag), ex.kind === "partial" ? h("span", { class: "tag" }, "일부 시간") : null],
        sub: [ex.note, ex.kind === "partial" && ex.times ? MB.ranges(ex.times.ranges) : ""].filter(Boolean).join(" · ") || null,
        side: [h("span", null, MB.dShort(ex.s)), ex.e !== ex.s ? h("span", { class: "muted" }, `– ${MB.dShort(ex.e)}`) : null],
      });
    });

    fill(root, 
      pageHead("월간", "휴가·기간 일정과 확정된 회의만 보여줘요",
        pager(MB.dMonth(ms), move(-1), () => { M.start = MB.monthStart(t); M.sel = t; MB.render(); }, move(1), "이번 달", "이전 달", "다음 달", "mo")),
      onceNotice(MB.byStatus("longoff"), []),
      h("div", { class: "legend", "aria-hidden": "true" },
        h("span", null, h("i", { class: "pip" }), "휴가·일정 인원"),
        h("span", null, icon("flag"), "확정 회의"),
        h("span", null, "날짜를 누르면 아래에 자세히 나와요")),
      h("div", { class: "panel cal", role: "group", "aria-label": MB.dMonth(ms) + " 달력" }, cells),
      detail,
      h("section", { class: "sec", "aria-labelledby": "s-mlist" },
        secHead("s-mlist", "이달의 휴가·일정", null, h("span", { class: "sec__note" }, `${rows.length}건`), "leave", "tone-leave"),
        h("div", { class: "panel" }, list(rows, "이달에 등록된 휴가·일정이 없어요."))),
    );
  }

  // ================================================================
  // 4. 회의 — 후보 비교 + 확정
  // ================================================================
  const PERIODS = [
    ["1w", "앞으로 7일"], ["2w", "앞으로 2주"], ["thisMonth", "이번 달 남은 날"], ["nextMonth", "다음 달"], ["custom", "직접 고르기"],
  ];
  function periodRange() {
    const t = MB.today(), m = ui.meet;
    if (m.period === "1w") return [t, t + 6];
    if (m.period === "thisMonth") return [t, MB.monthEnd(t)];
    if (m.period === "nextMonth") { const s = MB.addMonths(t, 1); return [s, MB.monthEnd(s)]; }
    if (m.period === "custom") {
      const a = m.from ?? t, b = m.to ?? t + 13;
      return a <= b ? [a, b] : [b, a];
    }
    return [t, t + 13];
  }
  const hourLabel = (x) => (x > 24 ? `익일 ${MB.pad(x - 24)}:00` : `${MB.pad(x)}:00`);
  const daysLabel = (ds) => (ds.length === 7 ? "매일" : ds.length ? ds.map((d) => MB.DAY[d]).join("·") : "요일 없음");

  function condsSummary() {
    const [a, b] = periodRange();
    return `${MB.dMD(a)}–${MB.dMD(b)} · ${daysLabel(ui.meet.days)} · ${hourLabel(ui.meet.startH)}–${hourLabel(ui.meet.endH)}`;
  }

  function renderMeet(root) {
    const m = ui.meet;
    const db = MB.getDB();

    const seg = h("div", { class: "seg", role: "group", "aria-label": "회의 길이" },
      [30, 60, 90, 120].map((min) => h("button", {
        type: "button", "aria-pressed": String(m.minutes === min), dataset: { fk: "len-" + min },
        onclick: (e) => { m.minutes = min; m.open = null; e.currentTarget.parentNode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); refreshCands(); },
      }, `${min}분`)));

    const teamSel = h("select", { class: "select", id: "mt-team", onchange: (e) => { m.team = e.target.value; m.open = null; refreshCands(); } },
      h("option", { value: "" }, "전체"),
      db.teams.map((t) => h("option", { value: t, selected: m.team === t }, t)));

    const periodSel = h("select", { class: "select", id: "mt-period", onchange: (e) => {
      m.period = e.target.value; m.open = null;
      if (m.period === "custom" && m.from == null) { const [a, b] = [MB.today(), MB.today() + 13]; m.from = a; m.to = b; }
      customBox.hidden = m.period !== "custom"; refreshCands();
    } }, PERIODS.map(([v, l]) => h("option", { value: v, selected: m.period === v }, l)));

    const dateIn = (key, lbl) => h("div", { class: "field" },
      h("label", { for: "mt-" + key }, lbl),
      h("input", { class: "input", type: "date", id: "mt-" + key, value: MB.dkey(m[key] ?? (key === "from" ? MB.today() : MB.today() + 13)),
        onchange: (e) => { const n = MB.parseDate(e.target.value); if (n != null) { m[key] = n; m.open = null; refreshCands(); } } }));
    const customBox = h("div", { class: "grid2 custom", hidden: m.period !== "custom" }, dateIn("from", "시작 날짜"), dateIn("to", "끝 날짜"));

    const daysBox = h("div", { class: "days", role: "group", "aria-label": "요일 고르기" },
      MB.DAY.map((d, i) => h("button", {
        type: "button", "aria-pressed": String(m.days.includes(i)), "aria-label": MB.DAY_FULL[i], dataset: { fk: "day-" + i },
        onclick: (e) => {
          m.days = m.days.includes(i) ? m.days.filter((x) => x !== i) : [...m.days, i].sort();
          e.currentTarget.setAttribute("aria-pressed", String(m.days.includes(i)));
          m.open = null; refreshCands();
        },
      }, d)));

    const hourSel = (key, from, to, lbl) => h("div", { class: "field" },
      h("label", { for: "mt-" + key }, lbl),
      h("select", { class: "select", id: "mt-" + key, onchange: (e) => { m[key] = +e.target.value; m.open = null; refreshCands(); } },
        Array.from({ length: to - from + 1 }, (_, i) => from + i).map((x) => h("option", { value: x, selected: m[key] === x }, hourLabel(x)))));

    const sumText = h("span", { class: "sum" }, condsSummary());
    const more = h("details", { class: "more-conds full", open: window.matchMedia("(min-width: 768px)").matches },
      h("summary", null, icon("chev"), "기간 · 요일 · 시간", sumText),
      h("div", { class: "more-conds__body" },
        h("div", { class: "field" }, h("label", { for: "mt-period" }, "확인할 기간"), periodSel),
        customBox,
        h("div", { class: "field" }, h("span", { class: "lbl", id: "mt-days-l" }, "요일"), daysBox),
        h("div", { class: "grid2 hours" }, hourSel("startH", 6, 23, "시작 시간부터"), hourSel("endH", 7, 26, "끝나는 시간까지"))));

    const conds = h("form", { class: "panel conds", onsubmit: (e) => e.preventDefault(), "aria-label": "회의 조건" },
      h("div", { class: "field" }, h("label", { for: "mt-title" }, "회의 이름"),
        h("input", { class: "input", id: "mt-title", value: m.title, maxlength: 40, autocomplete: "off", oninput: (e) => { m.title = e.target.value; } })),
      h("div", { class: "field" }, h("label", { for: "mt-team" }, "대상 팀"), teamSel),
      h("div", { class: "field len" }, h("span", { class: "lbl" }, "회의 길이"), seg),
      more);

    const candBox = h("div", { id: "cand-box" });
    const doneBox = h("div", { id: "done-box" });

    fill(root, 
      pageHead("회의", "작업 가능 시간을 보고 후보를 비교한 뒤 확정해요"),
      conds,
      h("section", { class: "sec", "aria-labelledby": "s-cand" }, candBox),
      h("section", { class: "sec", "aria-labelledby": "s-done" }, doneBox),
    );

    function refreshCands() {
      sumText.textContent = condsSummary();
      renderCandidates(candBox);
    }
    refreshCands();
    renderConfirmed(doneBox);
  }

  function renderCandidates(box) {
    const m = ui.meet;
    const [from, to] = periodRange();
    const r = MB.meetingCandidates({ from, to, days: m.days, startH: m.startH, endH: m.endH, minutes: m.minutes, team: m.team, limit: 5 });
    const head = secHead("s-cand", "후보 시간", null,
      h("span", { class: "sec__note" }, r.list.length ? `대상 ${r.pool.length}명 · 자동 확인 많은 순` : ""), "meet");

    let body;
    if (!m.days.length) body = h("div", { class: "panel" }, emptyLine("요일을 하나 이상 골라주세요."));
    else if (m.endH - m.startH < m.minutes / 60) body = h("div", { class: "panel" }, emptyLine("시간 범위가 회의 길이보다 짧아요."));
    else if (!r.pool.length) body = h("div", { class: "panel" }, emptyLine("이 팀에는 대상 인원이 없어요."));
    else if (!r.list.length) body = h("div", { class: "panel" }, emptyLine("조건에 맞는 시간에 자동 확인된 사람이 없어요. 기간이나 시간 범위를 넓혀 보세요."));
    else body = h("ol", { class: "cands" }, r.list.map((c, i) => candidateCard(c, i, box)));
    fill(box, head, body);
  }

  function candidateCard(c, i, box) {
    const m = ui.meet;
    const key = `${c.n}@${c.t}@${c.L}`;
    const isOpen = m.open === key;
    const pct = (x) => `${(x / Math.max(1, c.total)) * 100}%`;
    const names = (arr) => (arr.length ? arr.map((p) => p.name).join(", ") : h("span", { class: "none" }, "없음"));
    const hardLine = [];
    if (c.leave.length) hardLine.push(`휴가·일정: ${c.leave.map((p) => p.name).join(", ")}`);
    if (c.no.length) hardLine.push(`시간 안 맞음: ${c.no.map((p) => p.name).join(", ")}`);

    const card = h("li", { class: "panel cand" + (isOpen ? " is-open" : "") },
      h("div", { class: "cand__top" },
        h("span", { class: "cand__rank", "aria-label": `${i + 1}순위` }, String(i + 1)),
        h("div", { class: "cand__when" }, MB.dLong(c.n), h("span", null, MB.range([c.t, c.t + c.L])))),
      h("div", { class: "cand__ok" }, h("b", null, `${c.ok.length}명`), h("span", null, `자동 확인 가능 · 대상 ${c.total}명`)),
      h("div", { class: "meter", role: "img", "aria-label": `대상 ${c.total}명 중 자동 확인 ${c.ok.length}명, 추가 확인 필요 ${c.need}명` },
        h("i", { class: "m-ok", style: `width:${pct(c.ok.length)}` }), h("i", { class: "m-need", style: `width:${pct(c.need)}` })),
      h("dl", { class: "kv" },
        h("div", { class: "tone-check" }, h("dt", null, icon("help"), "일정별 확인 필요"), h("dd", null, names(c.needCheck))),
        h("div", { class: "tone-miss" }, h("dt", null, icon("alert"), "스케줄 미제출"), h("dd", null, names(c.needSubmit))),
        c.needTime.length ? h("div", { class: "tone-check" }, h("dt", null, icon("help"), "시간 미정"), h("dd", null, names(c.needTime))) : null,
        h("div", { class: "tone-off" }, h("dt", null, icon("x"), `참여 어려움 ${c.hard}명`), h("dd", null, hardLine.length ? hardLine.join(" · ") : h("span", { class: "none" }, "없음")))),
      h("details", { class: "fold", style: "margin:0 -16px" },
        h("summary", null, icon("chev"), `자동 확인된 ${c.ok.length}명 보기`),
        h("p", { style: "padding:10px 16px 0;font-size:14px;color:var(--ink-2)" }, c.ok.map((p) => p.name).join(", "))),
      isOpen ? confirmForm(c, box) : h("div", { class: "actions" },
        h("button", { type: "button", class: "btn btn--primary", dataset: { fk: "fix-" + key }, onclick: () => { m.open = key; m.msg = ""; m.draftTitle = null; m.draftMemo = ""; renderCandidates(box); const f = document.getElementById("cf-title"); if (f) f.focus(); } },
          icon("ok"), "이 시간으로 확정")));
    return card;
  }

  function confirmForm(c, box) {
    const m = ui.meet;
    const api = MB.Meetings.mode === "api";
    const needPass = api && !m.pass;
    const titleIn = h("input", { class: "input", id: "cf-title", value: m.draftTitle ?? m.title, maxlength: 40, oninput: (e) => { m.draftTitle = e.target.value; } });
    const memoIn = h("textarea", { class: "input", id: "cf-memo", maxlength: 300, placeholder: "안건, 장소, 링크 등 (선택)", oninput: (e) => { m.draftMemo = e.target.value; } });
    memoIn.value = m.draftMemo || "";
    const passIn = needPass ? h("input", { class: "input", id: "cf-pass", type: "password", autocomplete: "current-password" }) : null;
    const msg = h("p", { class: "confirm__msg " + (m.msg ? "is-err" : "is-info"), role: m.msg ? "alert" : null },
      m.msg || (api ? `${MB.dLong(c.n)} ${MB.range([c.t, c.t + c.L])} · 대상 ${m.team || "전체"} — 시트 '회의 확정' 탭에 저장돼요.`
        : "Apps Script가 연결되지 않아 이 기기 브라우저에만 저장돼요. 다른 기기에서는 안 보여요."));

    const saveBtn = h("button", { type: "button", class: "btn btn--primary" }, icon("ok"), "확정하기");
    const fail = (text) => {
      // 입력한 내용은 그대로 두고 문구만 바꿔요
      msg.textContent = text; msg.className = "confirm__msg is-err"; msg.setAttribute("role", "alert");
      MB.fill(saveBtn, icon("ok"), "확정하기"); saveBtn.disabled = false;
      if (passIn) { passIn.value = ""; passIn.focus(); }
    };
    const save = async () => {
      const btn = saveBtn;
      btn.disabled = true; btn.textContent = "저장하는 중…";
      const pass = needPass ? passIn.value : m.pass;
      const summarize = (label, arr) => (arr.length ? `${label} ${arr.map((p) => p.name).join(", ")}` : "");
      const meeting = {
        id: `M${MB.dkey(c.n).replace(/-/g, "")}-${MB.pad(Math.floor(c.t))}${MB.pad(Math.round((c.t % 1) * 60))}-${Math.random().toString(36).slice(2, 6)}`,
        title: MB.norm(titleIn.value) || "회의", team: m.team || "전체",
        n: c.n, date: MB.dkey(c.n), start: c.t, end: c.t + c.L, at: MB.stampNow(),
        ok: `${c.ok.length}명: ${c.ok.map((p) => p.name).join(", ")}`,
        need: [summarize("일정별 확인 필요", c.needCheck), summarize("스케줄 미제출", c.needSubmit), summarize("시간 미정", c.needTime)].filter(Boolean).join(" / ") || "없음",
        memo: MB.norm(memoIn.value), status: "예정",
      };
      let res;
      try { res = await MB.Meetings.create(meeting, pass); }
      catch (err) { res = { ok: false, error: "저장 중 연결이 끊겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요." }; }
      if (!res.ok) { fail(res.error || "저장하지 못했어요."); return; }
      if (needPass) { m.pass = pass; try { sessionStorage.setItem(PASS_KEY, pass); } catch (x) { /* 무시 */ } }
      m.title = meeting.title; m.open = null; m.msg = ""; m.draftTitle = null; m.draftMemo = "";
      m.flash = `${MB.dLong(c.n)} ${MB.range([c.t, c.t + c.L])} ‘${meeting.title}’을 확정했어요.`;
      MB.render();
      const done = document.getElementById("s-done"); if (done) { done.scrollIntoView({ behavior: "smooth", block: "start" }); done.setAttribute("tabindex", "-1"); done.focus({ preventScroll: true }); }
    };

    saveBtn.addEventListener("click", save);
    return h("div", { class: "confirm" },
      msg,
      h("div", { class: "field" }, h("label", { for: "cf-title" }, "회의명"), titleIn),
      h("div", { class: "field" }, h("label", { for: "cf-memo" }, "메모"), memoIn),
      needPass ? h("div", { class: "field" }, h("label", { for: "cf-pass" }, "관리 비밀번호"), passIn,
        h("span", { class: "sec__note" }, "Apps Script에 정한 비밀번호예요. 이 탭을 닫기 전까지 기억해요.")) : null,
      h("div", { class: "actions" },
        saveBtn,
        h("button", { type: "button", class: "btn", onclick: () => { ui.meet.open = null; ui.meet.msg = ""; renderCandidates(box); } }, "닫기")));
  }

  function gcalLink(mt) {
    const stamp = (x) => { const day = mt.n + Math.floor(x / 24); const hh = Math.floor(x % 24), mm = Math.round((x % 1) * 60); return MB.dkey(day).replace(/-/g, "") + `T${MB.pad(hh)}${MB.pad(mm)}00`; };
    const q = new URLSearchParams({ action: "TEMPLATE", text: mt.title, dates: `${stamp(mt.start)}/${stamp(mt.end)}`, details: `${mt.memo ? mt.memo + "\n" : ""}대상: ${mt.team} · METRO Team Board`, ctz: CFG.timeZone || "Asia/Seoul" });
    return "https://calendar.google.com/calendar/render?" + q.toString();
  }

  function renderConfirmed(box) {
    const M = MB.Meetings, m = ui.meet, t = MB.today();
    const api = M.mode === "api";
    const upcoming = M.list.filter((x) => x.status === "예정" && x.n >= t);
    const past = M.list.filter((x) => !(x.status === "예정" && x.n >= t)).reverse();
    const canEdit = !api || !!m.pass;

    const setStatus = async (mt, status, btn) => {
      btn.disabled = true;
      const res = await M.setStatus(mt.id, status, m.pass).catch(() => ({ ok: false, error: "연결이 끊겼어요. 다시 시도해 주세요." }));
      m.flash = res.ok ? `‘${mt.title}’을 ${status}로 바꿨어요.` : res.error;
      MB.render();
    };
    const row = (mt) => {
      const isPastPlan = mt.status === "예정" && mt.n < t;
      const st = mt.status === "취소" ? h("span", { class: "badge tone-off" }, icon("x"), "취소")
        : mt.status === "완료" ? h("span", { class: "badge tone-ok" }, icon("ok"), "완료")
        : h("span", { class: "badge tone-brand" }, icon("flag"), isPastPlan ? "예정(지남)" : "예정");
      const acts = [];
      if (mt.status === "예정") {
        acts.push(h("a", { class: "btn btn--sm", href: gcalLink(mt), target: "_blank", rel: "noopener" }, icon("cal-plus"), "캘린더에 추가"));
        if (canEdit) {
          acts.push(h("button", { type: "button", class: "btn btn--sm", onclick: (e) => setStatus(mt, "완료", e.currentTarget) }, "완료로 표시"));
          acts.push(h("button", { type: "button", class: "btn btn--sm btn--quiet", onclick: (e) => { if (confirm(`‘${mt.title}’ (${MB.dShort(mt.n)})을 취소할까요?`)) setStatus(mt, "취소", e.currentTarget); } }, "취소"));
        }
      }
      return h("li", null,
        h("div", { class: "row mt-row" },
          h("span", { class: "dot", vars: { "--c": mt.status === "예정" ? "var(--brand)" : "var(--off)" }, "aria-hidden": "true" }),
          h("div", { class: "row__main" },
            h("div", { class: "row__title" }, h("span", { class: "row__name" }, mt.title), h("span", { class: "row__team" }, mt.team),
              mt.local ? h("span", { class: "tag" }, "이 기기") : null),
            h("div", { class: "row__sub" }, `${MB.dLong(mt.n)} ${MB.range([mt.start, mt.end])}`),
            mt.ok ? h("div", { class: "row__sub" }, h("b", null, "참석 가능 "), mt.ok) : null,
            mt.need && mt.need !== "없음" ? h("div", { class: "row__sub" }, h("b", null, "추가 확인 "), mt.need) : null,
            mt.memo ? h("div", { class: "row__sub" }, h("b", null, "메모 "), mt.memo) : null),
          h("div", { class: "row__side" }, st)),
        acts.length ? h("div", { class: "mt-acts" }, acts) : null);
    };

    const passBox = api && !m.pass ? (() => {
      const inp = h("input", { class: "input", type: "password", id: "adm-pass", autocomplete: "current-password" });
      const note = h("span", { class: "sec__note", role: "status" }, "상태를 바꾸려면 관리 비밀번호가 필요해요.");
      return h("div", { class: "panel panel--pad", style: "margin-bottom:10px;display:grid;gap:8px" },
        h("label", { for: "adm-pass", class: "sec__note", style: "font-weight:600;color:var(--ink-2)" }, "관리 비밀번호"),
        h("div", { class: "actions" }, h("div", { style: "flex:1;min-width:160px" }, inp),
          h("button", { type: "button", class: "btn", onclick: async (e) => {
            e.currentTarget.disabled = true;
            const r = await M.checkPass(inp.value).catch(() => ({ ok: false, error: "연결이 끊겼어요." }));
            if (r.ok) { m.pass = inp.value; try { sessionStorage.setItem(PASS_KEY, inp.value); } catch (x) { /* 무시 */ } MB.render(); }
            else { note.textContent = r.error || "비밀번호가 맞지 않아요."; e.currentTarget.disabled = false; }
          } }, "확인")),
        note);
    })() : null;

    fill(box, 
      secHead("s-done", "확정된 회의", null,
        h("span", { class: "sec__note" }, api ? "시트 ‘회의 확정’ 탭과 연결됨" : "이 기기에만 저장 중"), "flag"),
      m.flash ? h("p", { class: "notice", role: "status", style: "margin-bottom:10px" }, icon("ok"), m.flash) : null,
      M.error ? h("p", { class: "notice tone-miss", role: "alert", style: "margin-bottom:10px" }, icon("alert"), `회의 목록을 불러오지 못했어요: ${M.error}`) : null,
      passBox,
      h("div", { class: "panel" },
        upcoming.length ? h("ul", { class: "rows" }, upcoming.map(row)) : emptyLine("앞으로 예정된 회의가 없어요. 위 후보에서 확정해 보세요."),
        past.length ? h("details", { class: "fold" }, h("summary", null, icon("chev"), `지난 회의·완료·취소 ${past.length}개`), h("ul", { class: "rows" }, past.map(row))) : null),
      !api ? h("p", { class: "sec__note", style: "margin-top:8px" }, "팀 전체와 공유하려면 Apps Script를 연결해 주세요. (README 안내 참고)") : null,
    );
    m.flash = "";
  }

  // ================================================================
  // 5. 팀 명단
  // ================================================================
  const STATUS_FILTERS = [
    ["all", "전체", null], ["active", "활동 중", null], ["limited", "제한적 활동", null],
    ["longoff", "장기 OFF", "pause"], ["check", "일정별 확인 필요", "help"], ["nosubmit", "스케줄 미제출", "alert"],
  ];
  const passFilter = (p, f) => (f === "all" ? true : f === "active" ? p.activity === "active" && p.status !== "longoff"
    : f === "limited" ? p.activity === "limited" : p.status === f);

  function renderTeam(root) {
    const db = MB.getDB();
    const T = ui.team;
    const all = db.members;
    const cnt = (f) => all.filter((p) => passFilter(p, f)).length;

    const statsEl = h("div", { class: "summary summary--team" });
    const chips = h("div", { class: "chips", role: "group", "aria-label": "상태로 거르기" });
    const note = h("p", { class: "result-note", role: "status" });
    const listBox = h("div", { class: "panel" });

    const search = h("div", { class: "search" }, icon("search"),
      h("label", { class: "sr", for: "tm-q" }, "이름 검색"),
      h("input", { class: "input", id: "tm-q", type: "search", dataset: { fk: "tm-q" }, placeholder: "이름 검색", value: T.q, autocomplete: "off", oninput: (e) => { T.q = e.target.value; update(); } }));
    const teamSel = h("div", null, h("label", { class: "sr", for: "tm-team" }, "팀 고르기"),
      h("select", { class: "select", id: "tm-team", dataset: { fk: "tm-team" }, onchange: (e) => { T.team = e.target.value; update(); } },
        h("option", { value: "" }, "모든 팀"), db.teams.map((t) => h("option", { value: t, selected: T.team === t }, t))));

    const departed = db.departed;
    const forms = CFG.forms || {};

    fill(root, 
      pageHead("팀 명단", `현재 팀원 ${all.length}명`),
      statsEl,
      h("div", { class: "filters" }, search, teamSel, chips),
      note,
      listBox,
      h("section", { class: "sec", "aria-labelledby": "s-forms" },
        secHead("s-forms", "일정 제출 방법", null, null, "link"),
        h("div", { class: "panel panel--pad", style: "display:grid;gap:10px" },
          h("p", { style: "font-size:14px;color:var(--ink-2)" }, "매주 반복되는 작업 가능 시간은 ‘작업 가능 시간 폼’, 특정 날짜의 휴가·개인 일정이나 그날만 다른 시간은 ‘휴가·일정 폼’으로 내요. 같은 폼을 다시 내면 가장 최근 것만 반영돼요."),
          h("div", { class: "forms" },
            forms.weekly ? h("a", { class: "btn", href: forms.weekly, target: "_blank", rel: "noopener" }, icon("link"), "작업 가능 시간 폼") : null,
            forms.leave ? h("a", { class: "btn", href: forms.leave, target: "_blank", rel: "noopener" }, icon("link"), "휴가·일정 폼") : null))),
      h("section", { class: "sec" },
        h("details", { class: "panel fold" },
          h("summary", null, icon("chev"), `이전 참여자 보기 (${departed.length}명)`),
          departed.length
            ? h("ul", { class: "rows" }, departed.map((x) => personRow({ p: { name: x.name, team: x.team }, sub: [x.date && `${x.date} 종료`, x.memo].filter(Boolean).join(" · ") || null, side: h("span", { class: "muted" }, "빠진 멤버") })))
            : emptyLine(db.departedConfigured ? "빠진 멤버 탭에 기록된 사람이 없어요." : "config.js에 ‘빠진 멤버’ 탭 주소가 아직 없어요."))),
    );

    function update() {
      fill(statsEl, 
        STATUS_FILTERS.map(([f, label, ic]) => stat({
          tone: f === "all" || f === "active" || f === "limited" ? (f === "all" ? "tone-brand" : "tone-ok") : toneOf(f),
          ic, label: f === "all" ? "전체 팀원" : label, num: cnt(f), pressed: T.status === f,
          onclick: () => { T.status = T.status === f && f !== "all" ? "all" : f; update(); },
        })));
      fill(chips, STATUS_FILTERS.map(([f, label, ic]) => h("button", {
        type: "button", "aria-pressed": String(T.status === f), dataset: { fk: "tf-" + f },
        onclick: () => { T.status = f; update(); },
      }, ic ? icon(ic) : null, label)));

      const q = MB.squash(T.q);
      const shown = all
        .filter((p) => passFilter(p, T.status) && (!T.team || p.team === T.team) && (!q || MB.squash(p.name).includes(q)))
        .sort((a, b) => (a.team || "").localeCompare(b.team || "", "ko") || a.name.localeCompare(b.name, "ko"));
      note.textContent = shown.length === all.length ? `${all.length}명 모두 보는 중` : `${all.length}명 중 ${shown.length}명`;

      fill(listBox, list(shown.map((p) => {
        let line1, line2;
        if (p.status === "longoff") {
          line1 = [badge("longoff"), " ", offInfo(p)];
          line2 = offPeriod(p);
        } else {
          line1 = [ACTIVITY[p.activity] || "활동 중", " · ", badge(p.status)];
          line2 = p.status === "avail" ? MB.weeklySummary(p)
            : p.status === "check" ? "고정 시간 없이 일정마다 따로 확인"
            : "작업 가능 시간 폼을 아직 안 냈어요";
        }
        return h("li", null, h("div", { class: "row" },
          teamDot(p.team),
          h("div", { class: "row__main" },
            h("div", { class: "row__title" }, h("span", { class: "row__name" }, p.name), p.team ? h("span", { class: "row__team" }, p.team) : null),
            h("div", { class: "row__sub" }, line1),
            line2 ? h("div", { class: "row__sub" }, line2) : null,
            p.memo && p.status !== "longoff" ? h("div", { class: "row__sub" }, h("b", null, "메모 "), p.memo) : null,
            p.weeklyMemo && p.status === "avail" ? h("div", { class: "row__sub" }, h("b", null, "폼 메모 "), p.weeklyMemo) : null),
          h("span")));
      }), T.q ? `‘${T.q}’에 맞는 사람이 없어요.` : "조건에 맞는 사람이 없어요."));
    }
    update();
  }

  MB.views = { today: renderToday, week: renderWeek, month: renderMonth, meet: renderMeet, team: renderTeam };
})(window);
