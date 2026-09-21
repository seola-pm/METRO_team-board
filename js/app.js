/* ================================================================
   app.js — 화면 전환, 불러오기·오류·빈 상태, 자동 새로고침
   ================================================================ */
(function (global) {
  "use strict";
  const MB = global.MB;
  const { h, icon, clear, fill } = MB;
  const CFG = MB.cfg;
  const VIEWS = ["today", "week", "month", "meet", "team"];
  const TITLES = { today: "오늘", week: "주간", month: "월간", meet: "회의", team: "팀 명단" };

  const app = { view: "today", loading: false, loadedAt: null, error: "", firstLoad: true };
  const $ = (s) => document.querySelector(s);

  // ---------- 머리글 ----------
  function paintHeader() {
    const t = MB.today();
    const date = $("#hdrDate");
    fill(date, h("span", { class: "long" }, MB.dLong(t)), h("span", { class: "short" }, MB.dShort(t)));
    const s = $("#hdrSync");
    s.classList.toggle("is-loading", app.loading);
    s.classList.toggle("is-error", !app.loading && !!app.error);
    const stamp = app.loadedAt ? `${MB.pad(app.loadedAt.hh)}:${MB.pad(app.loadedAt.mm)}` : "";
    s.textContent = app.loading ? "불러오는 중" : app.error ? (stamp ? `갱신 실패 · ${stamp} 기준` : "불러오기 실패") : `${stamp} 갱신`;
    $("#refreshBtn").classList.toggle("is-spinning", app.loading);
    $("#refreshBtn").disabled = app.loading;
  }

  function paintAlert() {
    const el = $("#alert");
    if (!app.error || !MB.getDB()) { el.hidden = true; clear(el); return; }
    el.hidden = false;
    fill(el, icon("alert"), `최신 데이터를 불러오지 못해 ${MB.pad(app.loadedAt.hh)}:${MB.pad(app.loadedAt.mm)} 기준으로 보여주고 있어요.`,
      h("button", { type: "button", class: "btn btn--sm", onclick: () => load() }, "다시 시도"));
  }

  // ---------- 화면 그리기 ----------
  function render() {
    VIEWS.forEach((v) => { document.getElementById("v-" + v).hidden = v !== app.view; });
    document.querySelectorAll(".nav a").forEach((a) => {
      if (a.dataset.view === app.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    document.title = `${TITLES[app.view]} · ${CFG.title || "METRO Team Board"}`;
    paintHeader();
    paintAlert();

    const root = document.getElementById("v-" + app.view);
    const db = MB.getDB();
    if (!db) {
      if (app.error) return renderError(root);
      return renderLoading(root);
    }
    const fk = document.activeElement && root.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    try {
      MB.views[app.view](root);
    } catch (e) {
      console.error("[METRO] 화면 그리기 오류", e);
      fill(root, stateBox("err", "화면을 그리다 문제가 생겼어요", "시트 데이터 모양이 예상과 다를 수 있어요. 새로고침해 보고, 계속되면 관리자에게 알려주세요.", true));
    }
    if (fk) { const el = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (el) el.focus({ preventScroll: true }); }
  }
  MB.render = render;

  function stateBox(kind, title, text, retry) {
    return h("div", { class: "panel state" + (kind === "err" ? " state--err" : "") },
      h("h2", null, icon(kind === "err" ? "alert" : "info"), title),
      h("p", null, text),
      retry ? h("button", { type: "button", class: "btn btn--primary", onclick: () => load() }, icon("refresh"), "다시 시도") : null);
  }
  function renderLoading(root) {
    fill(root, 
      h("div", { class: "page-head" }, h("h1", { class: "page-title" }, TITLES[app.view])),
      h("div", { class: "skel", role: "status", "aria-label": "시트 데이터를 불러오는 중" }, h("i"), h("i"), h("i"), h("i")));
  }
  function renderError(root) {
    fill(root, 
      h("div", { class: "page-head" }, h("h1", { class: "page-title" }, TITLES[app.view])),
      stateBox("err", "시트 데이터를 불러오지 못했어요", app.error + " 인터넷 연결과 config.js의 시트 주소, 시트의 ‘웹에 게시’ 상태를 확인해 주세요.", true));
  }

  // ---------- 불러오기 ----------
  let loadSeq = 0;
  async function load(quiet) {
    const seq = ++loadSeq;
    app.loading = true;
    if (!quiet) paintHeader();
    try {
      const raw = await MB.loadSheets();
      const db = MB.build(raw);
      await MB.Meetings.load();
      if (seq !== loadSeq) return;
      MB.setDB(db);
      app.error = "";
      app.loadedAt = MB.now();
      if (raw.notes.length) console.warn("[METRO]", raw.notes.join(" / "));
    } catch (e) {
      if (seq !== loadSeq) return;
      console.error("[METRO] 불러오기 실패", e);
      app.error = e && e.message ? e.message : String(e);
    } finally {
      if (seq === loadSeq) app.loading = false;
    }
    // 회의 화면에서 입력 중일 때는 자동 새로고침으로 화면을 다시 그리지 않아요
    const typing = quiet && app.view === "meet" && document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (typing || (quiet && app.view === "meet" && MB.ui.meet.open)) { paintHeader(); paintAlert(); return; }
    render();
  }

  // ---------- 화면 전환 ----------
  function route() {
    const v = location.hash.replace(/^#/, "");
    app.view = VIEWS.includes(v) ? v : "today";
    render();
    window.scrollTo(0, 0);
  }

  function sideLinks() {
    const f = CFG.forms || {};
    const box = $("#sideLinks");
    fill(box, 
      h("p", null, "일정 제출 폼"),
      f.weekly ? h("a", { class: "btn btn--sm btn--quiet", href: f.weekly, target: "_blank", rel: "noopener" }, icon("link"), "작업 가능 시간") : null,
      f.leave ? h("a", { class: "btn btn--sm btn--quiet", href: f.leave, target: "_blank", rel: "noopener" }, icon("link"), "휴가·일정") : null);
  }

  function init() {
    $("#brandName").textContent = CFG.title || "METRO Team Board";
    sideLinks();
    $("#refreshBtn").addEventListener("click", () => load());
    window.addEventListener("hashchange", route);
    // 처음에는 반드시 '오늘' (주소에 다른 화면이 적혀 있으면 그 화면)
    route();
    load();
    const every = Math.max(1, Number(CFG.refreshMinutes) || 3) * 60000;
    setInterval(() => { if (!document.hidden) load(true); }, every);
    // 날짜가 바뀌거나 '지금' 표시를 맞추려고 1분마다 머리글과 오늘 화면만 다시 그려요
    let lastDay = MB.today();
    setInterval(() => {
      const d = MB.today();
      if (d !== lastDay) { lastDay = d; MB.ui.week.start = null; MB.ui.month.start = null; render(); return; }
      paintHeader();
      if (app.view === "today" && MB.getDB()) render();
    }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && app.loadedAt) load(true); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})(window);
