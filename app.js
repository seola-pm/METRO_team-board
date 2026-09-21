/* METRO Team Board
 * 시트에서 받은 데이터를 화면에 그리는 파일입니다.
 *  - 기본 연결(config.js의 API_URL): 명단·근무시간을 보내주는 기존 Apps Script
 *  - 관리용 연결(config.js의 ADMIN_API_URL): 휴가 일정 읽기, 회의 확정·수정·취소, 링크 추가·삭제 (metro-admin.gs)
 * 날짜·시간 형식이 조금 달라도 알아서 맞춰 읽도록 만들어져 있어요.
 */
(() => {
  'use strict';

  const VERSION = '2026-09-21-3';
  const C = window.METRO_CONFIG || {};
  const MAIN_URL = String(C.API_URL || '').trim();
  const ADMIN_URL = String(C.ADMIN_API_URL || '').trim();
  const LEAVE_TAB = '휴가일정 응답';
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const EN_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const REFRESH_MS = 60 * 1000;   // 1분마다 시트를 다시 읽어요
  const LONG_LEAVE_DAYS = 30;     // 이 기간 이상 쉬는 일정은 '장기 OFF'로 봐요

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* 저장 불가 환경 */ } },
  };

  const state = {
    raw: { main: null, admin: null, sheetLeaves: null },
    src: {
      main: { status: MAIN_URL ? 'idle' : 'off', error: '' },
      admin: { status: ADMIN_URL ? 'idle' : 'off', error: '' },
      sheet: { status: 'off', error: '' },
    },
    leaveSource: '',
    data: emptyData(),
    idx: { avail: new Map(), leaves: new Map() },
    cache: new Map(),
    hasData: false,
    loading: false,
    lastSync: null,
    syncError: '',
    renderedDay: '',
    month: monthStart(new Date()),
    meetMonth: monthStart(new Date()),
    adminUnlocked: session.get('metroAdminUnlocked') === '1',
    adminPass: '',
    meetDraft: null,
    meetResult: null,
    dlg: null,
    linkFormOpen: false,
    linkDraft: null,
    features: {},          // 관리용 연결에서 켜진 기능 (디스코드 공지, 구글 캘린더)
    notifyDiscord: true,   // 확정·수정·취소할 때 디스코드에도 알릴지
    showAllCand: false,
  };

  /* ───────── 날짜·시간 도우미 ───────── */

  function emptyData() { return { team: [], availability: [], leaves: [], meetings: [], links: [] }; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function keyToDate(k) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function daysBetween(a, b) { return Math.round((keyToDate(b) - keyToDate(a)) / 864e5); }
  function minOf(d) { return d.getHours() * 60 + d.getMinutes(); }
  function fmtM(n) { return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`; }
  function fmtDate(d) { return `${d.getMonth() + 1}월 ${d.getDate()}일(${DAYS[d.getDay()]})`; }
  function fmtKey(k) { const d = keyToDate(k); return d ? `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}` : k; }
  function fmtShort(k) { const d = keyToDate(k); return d ? `${d.getMonth() + 1}/${d.getDate()}` : k; }
  function clock(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function hhmm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/;
  const DATE_RE = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/;
  const GVIZ_DATE = /^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2}))?/;

  // "2026. 9. 19", "2026-09-19", "2026-09-18T15:00:00.000Z"(시트 날짜가 UTC로 온 경우) → "2026-09-19"
  function toKey(v) { return toDateTime(v).date; }

  // 날짜+시각 → { date: "2026-09-25", min: 1260 }
  function toDateTime(v) {
    if (v === null || v === undefined || v === '') return { date: '', min: null };
    if (v instanceof Date) return isNaN(v) ? { date: '', min: null } : { date: dateKey(v), min: minOf(v) };
    const s = String(v).trim();
    if (ISO_WITH_ZONE.test(s)) { const d = new Date(s); if (!isNaN(d)) return { date: dateKey(d), min: minOf(d) }; }
    const g = GVIZ_DATE.exec(s);
    if (g) return { date: `${g[1]}-${pad(+g[2] + 1)}-${pad(g[3])}`, min: g[4] ? +g[4] * 60 + +g[5] : null };
    const m = DATE_RE.exec(s);
    if (!m) return { date: '', min: timeToMin(s) };
    return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, min: timeToMin(s.slice(m.index + m[0].length)) };
  }

  // "21:00", "오후 9:00:00", "21시 30분", "14" → 분 단위 숫자
  function timeToMin(t) {
    if (typeof t === 'number') return isFinite(t) ? t : null;
    const s = String(t ?? '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return +s <= 24 ? +s * 60 : +s;
    const m = /(\d{1,2})(?:\s*[:시]\s*(\d{1,2}))?/.exec(s);
    if (!m) return null;
    let h = +m[1];
    const mi = +(m[2] || 0);
    if (/오후|pm/i.test(s) && h < 12) h += 12;
    if (/오전|am/i.test(s) && h === 12) h = 0;
    if (h > 48 || mi > 59) return null;
    return h * 60 + mi;
  }

  // 밤을 넘기는 시간(22시~02시)은 끝 시간을 다음 날로 넘겨서 저장해요
  function normRange(s, e) {
    if (s === null || e === null || isNaN(s) || isNaN(e) || s === e) return [];
    if (e < s) e += 1440;
    if (s < 0 || s >= 1440 || e > 2880) return [];
    return [{ start: s, end: e }];
  }

  // "14-18", "14:00~18:00, 20:00-24:00", "오후 2시-오후 6시" → 시간 구간 목록
  function parseRangeText(text) {
    return String(text ?? '').split(/[,\n/]|그리고/).flatMap(part => {
      const bits = part.split(/\s*(?:~|–|—|〜|-|부터|에서)\s*/).map(x => x.trim()).filter(Boolean);
      return bits.length < 2 ? [] : normRange(timeToMin(bits[0]), timeToMin(bits[1]));
    });
  }

  function toRanges(v) {
    if (v === null || v === undefined || v === '') return [];
    if (Array.isArray(v)) {
      return v.flatMap(x => (x && typeof x === 'object')
        ? normRange(timeToMin(pick(x, 'start', 'from', 'begin', '시작')), timeToMin(pick(x, 'end', 'to', 'finish', '종료')))
        : toRanges(x));
    }
    if (typeof v === 'object') return toRanges([v]);
    return parseRangeText(v);
  }

  function mergeRanges(list) {
    const out = [];
    list.filter(r => r.end > r.start).sort((a, b) => a.start - b.start).forEach(r => {
      const last = out[out.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else out.push({ start: r.start, end: r.end });
    });
    return out;
  }

  function subtractRanges(base, blocked) {
    let out = base.map(x => ({ ...x }));
    blocked.forEach(b => {
      out = out.flatMap(r => (b.end <= r.start || b.start >= r.end) ? [r]
        : [{ start: r.start, end: Math.max(r.start, b.start) }, { start: Math.min(r.end, b.end), end: r.end }].filter(x => x.end > x.start));
    });
    return out;
  }

  function dayIndices(v) {
    if (typeof v === 'number') return [((v % 7) + 7) % 7];
    const tokens = (Array.isArray(v) ? v : String(v ?? '').split(/[,/·\s]+/)).map(x => String(x).trim()).filter(Boolean);
    const out = [];
    tokens.forEach(t => {
      if (t.length > 1 && /^[일월화수목금토]+$/.test(t)) { [...t].forEach(ch => out.push(DAYS.indexOf(ch))); return; }
      let i = DAYS.findIndex(d => t.startsWith(d));
      if (i < 0) i = EN_DAYS.findIndex(d => t.toLowerCase().startsWith(d));
      if (i >= 0) out.push(i);
    });
    return [...new Set(out)];
  }

  // 항목 이름이 조금 달라도(띄어쓰기·대소문자·밑줄) 같은 칸으로 찾아요: "Start Date" = "start_date" = "startDate"
  const normKey = k => String(k).replace(/[\s_\-]+/g, '').toLowerCase();
  function pick(o, ...keys) {
    if (!o || typeof o !== 'object') return '';
    for (const k of keys) { const v = o[k]; if (v !== undefined && v !== null && v !== '') return v; }
    const map = {};
    Object.keys(o).forEach(k => { map[normKey(k)] = o[k]; });
    for (const k of keys) { const v = map[normKey(k)]; if (v !== undefined && v !== null && v !== '') return v; }
    return '';
  }
  function nameKey(n) { return String(n ?? '').replace(/\s+/g, '').toLowerCase(); }
  function splitNames(v) {
    if (v === null || v === undefined || v === '') return [];
    const list = Array.isArray(v) ? v : String(v).split(/[,\n、]/);
    return list.map(x => String(x && typeof x === 'object' ? pick(x, 'name', '이름') : x).trim()).filter(Boolean);
  }
  function stamp(v) {
    const t = toDateTime(v);
    const d = keyToDate(t.date);
    return d ? d.getTime() + (t.min || 0) * 60000 : 0;
  }

  /* ───────── 시트 데이터 정리 ───────── */

  function normalize(json) {
    const out = emptyData();
    const list = (...keys) => { const v = pick(json, ...keys); return Array.isArray(v) ? v : []; };
    const people = new Map();
    const addPerson = (name, extra = {}) => {
      const key = nameKey(name);
      if (!key) return null;
      let p = people.get(key);
      if (!p) { p = { name: String(name).trim(), key, team: '', status: '', order: people.size }; people.set(key, p); }
      Object.entries(extra).forEach(([k, v]) => { if (v) p[k] = v; });
      return p;
    };

    list('team', 'members', 'roster', 'people', '명단').forEach(p => {
      if (typeof p === 'string') { addPerson(p); return; }
      addPerson(pick(p, 'name', '이름', '닉네임'), {
        team: String(pick(p, 'team', '팀', '소속', '소속팀')).trim(),
        status: String(pick(p, 'status', '상태')).trim(),
      });
    });
    // [빠진 멤버] 탭 이름은 명단에 없어도 추가하고, [스케줄 현황] 목록은 명단에 있는 사람에게만 적용해요
    splitNames(pick(json, 'left', 'removed', 'leftMembers', '빠진 멤버')).forEach(n => { const p = addPerson(n); if (p) p.status = '빠진 멤버'; });
    const onRoster = (v, fn) => splitNames(v).forEach(n => { const p = people.get(nameKey(n)); if (p) fn(p); });
    onRoster(pick(json, 'long', 'longOff', '장기 OFF'), p => { if (baseKind(p) !== 'left') p.status = '장기 OFF'; });
    onRoster(pick(json, 'check', 'checkMembers', '일정별 확인'), p => { if (baseKind(p) === 'active') p.status = '일정별 확인'; });
    onRoster(pick(json, 'missing', 'unsubmitted', 'notSubmitted', '미제출'), p => { p.forceMissing = true; });
    const hadRoster = people.size > 0;

    list('availability', 'work', 'schedules', 'schedule', 'workTimes', 'hours', '근무시간', '근무시간 응답').forEach(a => {
      const name = String(pick(a, 'name', '이름', '닉네임')).trim();
      if (!name) return;
      const ts = stamp(pick(a, 'timestamp', 'submittedAt', '타임스탬프'));
      const days = dayIndices(pick(a, 'day', 'days', 'weekday', '요일'));
      const push = (day, raw) => {
        const ranges = toRanges(raw);
        const text = typeof raw === 'string' ? raw : '';
        out.availability.push({ name, key: nameKey(name), day, ranges, ts, unreadable: !ranges.length && /\d/.test(text) });
      };
      const rawTime = () => {
        const r = a.ranges ?? pick(a, 'ranges', 'time', 'times', 'hours', 'range', '시간', '가능 시간');
        if (r !== '' && r !== undefined && r !== null) return r;
        const s = pick(a, 'start', 'startTime', 'from', 'begin', '시작', '시작 시간');
        const e = pick(a, 'end', 'endTime', 'to', 'finish', '종료', '종료 시간');
        return s !== '' && e !== '' ? [{ start: s, end: e }] : '';
      };
      if (days.length) days.forEach(d => push(d, rawTime()));
      else DAYS.forEach((d, i) => { const v = pick(a, d, d + '요일', EN_DAYS[i]); if (v !== '') push(i, v); });
    });

    list('leaves', 'leave', 'vacations', 'vacation', 'offs', 'absences', 'exceptions', '휴가', '휴가일정').forEach(l => {
      const name = String(pick(l, 'name', '이름', '닉네임')).trim();
      let start = toKey(pick(l, 'start', 'startDate', 'from', 'dateFrom', 'begin', 'date', '시작일', '시작 날짜', '시작', '날짜'));
      let end = toKey(pick(l, 'end', 'endDate', 'to', 'dateTo', 'until', '종료일', '종료 날짜', '종료')) || start;   // 종료일이 비어 있으면 하루짜리
      if (!name || !start) return;
      if (end < start) [start, end] = [end, start];
      const type = String(pick(l, 'type', 'kind', 'category', '종류', '구분')).trim();
      const ranges = toRanges(l.ranges ?? pick(l, 'ranges', 'time', 'times', 'hours', '시간'));
      const whole = ranges.some(r => r.start <= 0 && r.end >= 1440);
      let kind;
      if (/다른\s*시간/.test(type)) kind = ranges.length ? 'alt' : 'note';
      else if (/몇\s*시간|시간만|일부|잠깐/.test(type)) kind = whole ? 'full' : 'partial';
      else if (/통째|종일|전체|하루/.test(type)) kind = 'full';
      else kind = ranges.length && !whole ? 'partial' : 'full';
      out.leaves.push({ name, key: nameKey(name), start, end, type, kind, ranges, memo: String(pick(l, 'memo', 'note', 'reason', 'content', 'description', '내용', '사유', '메모')).trim() });
    });

    list('meetings', 'meeting', '확정 회의', '회의').forEach(m => {
      const rawStart = pick(m, 'start', 'startAt', 'startTime', '시작 일시', '시작일시', '시작');
      const st = toDateTime(rawStart);
      if (!st.date) return;
      const status = String(pick(m, 'status', '상태')).trim();
      if (/취소/.test(status)) return;
      const en = toDateTime(pick(m, 'end', 'endAt', 'endTime', '종료 일시', '종료일시', '종료'));
      const s = st.min ?? 0;
      let e = en.min ?? s + 60;
      if ((en.date && en.date > st.date) || e <= s) e += 1440;
      const rawTitle = String(pick(m, 'title', '회의명', 'name', '제목')).trim();
      out.meetings.push({
        id: pick(m, 'id', 'row'), rawStart: String(rawStart).trim(), rawTitle,
        title: rawTitle || '회의', date: st.date, start: s, end: e, status,
        members: splitNames(m.members ?? pick(m, 'members', '참석자', 'attendees')),
        place: String(pick(m, 'place', '회의 링크/장소', '장소', 'link', '링크')).trim(),
      });
    });
    out.meetings.sort((a, b) => (a.date + pad(a.start)).localeCompare(b.date + pad(b.start)));

    list('links', '링크').forEach(x => {
      const url = String(pick(x, 'url', 'href', '주소', '링크')).trim();
      if (!/^https?:\/\//i.test(url)) return;
      out.links.push({ id: String(pick(x, 'id', 'ID') || url), title: String(pick(x, 'title', 'name', '이름', '링크 이름')).trim() || url, url, memo: String(pick(x, 'memo', 'description', '설명')).trim() });
    });

    // 폼에 적힌 이름이 명단에 없으면 따로 표시해요 (오타 찾기용)
    [...out.availability, ...out.leaves].forEach(r => {
      if (people.has(r.key)) return;
      const p = addPerson(r.name);
      if (hadRoster) p.unlisted = true;
    });

    out.team = [...people.values()].sort((a, b) => a.order - b.order);
    return out;
  }

  function buildIndex(d) {
    const latest = new Map();
    d.availability.forEach(a => latest.set(a.key, Math.max(latest.get(a.key) || 0, a.ts)));
    const avail = new Map();
    d.availability.forEach(a => {
      if (a.ts && a.ts < latest.get(a.key)) return;   // 같은 사람이 폼을 다시 냈으면 가장 최근 것만
      if (!avail.has(a.key)) avail.set(a.key, new Map());
      const byDay = avail.get(a.key);
      byDay.set(a.day, mergeRanges([...(byDay.get(a.day) || []), ...a.ranges]));
    });
    const leaves = new Map();
    d.leaves.forEach(l => { if (!leaves.has(l.key)) leaves.set(l.key, []); leaves.get(l.key).push(l); });
    return { avail, leaves };
  }

  // 기본 연결 + 관리용 연결 + (필요하면) 시트 직접 읽기를 합쳐요
  function recompute() {
    const merged = { ...(state.raw.main || {}) };
    const a = state.raw.admin;
    if (a) ['leaves', 'meetings', 'links', 'left', 'missing', 'check', 'long'].forEach(k => { if (Array.isArray(a[k])) merged[k] = a[k]; });
    let data = normalize(merged);
    state.leaveSource = data.leaves.length ? (a && Array.isArray(a.leaves) ? '관리용 연결' : '기본 연결') : '';
    if (!data.leaves.length && state.raw.sheetLeaves?.length) {
      data = normalize({ ...merged, leaves: state.raw.sheetLeaves });
      state.leaveSource = '시트 직접 읽기';
    }
    state.data = data;
    state.idx = buildIndex(data);
    state.cache = new Map();
    state.features = (a && a.features) || {};
  }

  /* ───────── 누가 언제 가능한지 계산 ───────── */

  function leavesOn(key, k) { return (state.idx.leaves.get(key) || []).filter(l => k >= l.start && k <= l.end); }
  function isFullLeave(key, date) { return leavesOn(key, dateKey(date)).some(l => l.kind === 'full'); }

  function ownRanges(key, date) {
    const ls = leavesOn(key, dateKey(date));
    if (ls.some(l => l.kind === 'full')) return [];
    const alt = ls.filter(l => l.kind === 'alt');
    const base = alt.length ? alt[alt.length - 1].ranges : (state.idx.avail.get(key)?.get(date.getDay()) || []);
    return subtractRanges(base, ls.filter(l => l.kind === 'partial').flatMap(l => l.ranges));
  }

  // 그날 0시~24시 안에서 가능한 시간 (전날 밤에서 넘어온 시간 포함)
  function rangesFor(key, date) {
    const ck = key + '|' + dateKey(date);
    if (state.cache.has(ck)) return state.cache.get(ck);
    let result = [];
    if (!isFullLeave(key, date)) {
      const own = ownRanges(key, date).map(r => ({ start: r.start, end: Math.min(r.end, 1440) }));
      const carry = ownRanges(key, addDays(date, -1)).filter(r => r.end > 1440).map(r => ({ start: 0, end: r.end - 1440 }));
      const blocked = leavesOn(key, dateKey(date)).filter(l => l.kind === 'partial').flatMap(l => l.ranges);
      result = mergeRanges(subtractRanges([...carry, ...own], blocked));
    }
    state.cache.set(ck, result);
    return result;
  }
  function isAvailable(key, date, s, e) { return rangesFor(key, date).some(r => r.start <= s && r.end >= e); }

  function baseKind(p) {
    const s = String(p?.status || '').replace(/\s+/g, '');
    if (/퇴사|나감|나간|탈퇴|빠짐|빠진|하차|제외/.test(s)) return 'left';
    if (/장기/.test(s)) return 'long';
    if (/확인|일정별|개별/.test(s)) return 'check';
    return 'active';
  }
  function hasSchedule(p) { return state.idx.avail.has(p.key); }
  // 근무시간 데이터가 들어오면 그걸로 판단하고, 아예 없을 때만 [스케줄 현황] 목록을 믿어요
  function isMissing(p) {
    if (baseKind(p) !== 'active') return false;
    return state.idx.avail.size ? !hasSchedule(p) : !!p.forceMissing;
  }
  function longLeaveOn(p, date) {
    return leavesOn(p.key, dateKey(date)).find(l => l.kind === 'full' && daysBetween(l.start, l.end) + 1 >= LONG_LEAVE_DAYS);
  }
  function longOffPeople(date) {
    return state.data.team.filter(p => { const k = baseKind(p); return k !== 'left' && (k === 'long' || !!longLeaveOn(p, date)); });
  }
  function boardPeople() { return state.data.team.filter(p => !['left', 'long'].includes(baseKind(p))); }
  function personByName(n) { return state.data.team.find(p => p.key === nameKey(n)); }

  // 하루 상태: 작업 가능 / 휴가·개인 일정 / 작업 불가 / 폼 미제출 / 일정별 확인
  function dayStatus(p, date) {
    const ls = leavesOn(p.key, dateKey(date));
    const full = ls.find(l => l.kind === 'full');
    if (full) return { kind: 'leave', leave: full };
    const ranges = rangesFor(p.key, date);
    const partials = ls.filter(l => l.kind === 'partial' || l.kind === 'alt' || l.kind === 'note');
    if (ranges.length) return { kind: 'work', ranges, partials };
    if (baseKind(p) === 'check') return { kind: 'check', partials };
    if (isMissing(p) || !hasSchedule(p)) return { kind: 'missing', partials };
    return { kind: 'off', partials };
  }

  function leaveLabel(l) {
    if (l.memo) return l.memo;
    if (/여행/.test(l.type)) return '여행';
    if (l.kind === 'partial') return '일부 시간 빠짐';
    return '휴가·개인 일정';
  }
  function leaveTip(l) {
    return [l.name, l.memo, l.type, l.start === l.end ? fmtKey(l.start) : `${fmtKey(l.start)} ~ ${fmtKey(l.end)}`].filter(Boolean).join(' / ');
  }
  function rangeText(ranges) { return ranges.map(r => `${fmtM(r.start)}–${fmtM(Math.min(r.end, 1440))}`).join(', '); }

  /* ───────── 공통 화면 조각 ───────── */

  function header(title, sub, extra = '') { return `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div>${extra}</div>`; }
  function placeholder() {
    if (state.syncError) {
      return `<div class="card placeholder"><strong>시트와 연결되지 않았어요</strong><p>${esc(state.syncError)}</p><button type="button" class="primary" data-reload>다시 연결</button></div>`;
    }
    return '<div class="card placeholder"><p>시트에서 불러오는 중이에요…</p></div>';
  }
  const GRID = `<div class="tl-grid" aria-hidden="true">${Array.from({ length: 23 }, (_, i) => `<i${(i + 1) % 6 === 0 ? ' class="major"' : ''} style="left:${(i + 1) / 24 * 100}%"></i>`).join('')}</div>`;
  const LEGEND = `<div class="legend" aria-label="표시 구분">${[
    ['work', '작업 가능'], ['part', '일부 시간 빠짐'], ['leave', '휴가·개인 일정'], ['off', '작업 불가'], ['missing', '폼 미제출'], ['check', '일정별 확인'],
  ].map(([k, t]) => `<span><i class="lg lg-${k}"></i>${t}</span>`).join('')}</div>`;

  function monthNav(id, base) {
    const same = base.getTime() === monthStart(new Date()).getTime();
    return `<div class="month-nav"><button type="button" class="ghost" data-cal="${id}" data-step="-1" aria-label="이전 달">‹</button>${same ? '' : `<button type="button" class="ghost" data-cal="${id}" data-step="0">이번 달로</button>`}<button type="button" class="ghost" data-cal="${id}" data-step="1" aria-label="다음 달">›</button></div>`;
  }

  function meetingIndex(m) { return state.data.meetings.indexOf(m); }

  function calendarHtml(base) {
    const y = base.getFullYear(), m = base.getMonth();
    const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate(), today = dateKey(new Date());
    const leftKeys = new Set(state.data.team.filter(p => baseKind(p) === 'left').map(p => p.key));
    const cells = [];
    for (let i = 0; i < first; i++) cells.push('<div class="day blank"></div>');
    for (let d = 1; d <= last; d++) {
      const k = dateKey(new Date(y, m, d));
      const leaves = state.data.leaves.filter(l => !leftKeys.has(l.key) && k >= l.start && k <= l.end);
      const meetings = state.data.meetings.filter(mt => mt.date === k);
      cells.push(`<div class="day${k === today ? ' today' : ''}"><span class="day-num">${d}</span>`
        + leaves.map(l => `<span class="event leave${l.kind === 'full' ? '' : ' part'}" title="${esc(leaveTip(l))}">${esc(l.name)}<small> ${esc(l.kind === 'full' ? leaveLabel(l) : rangeText(l.ranges) || leaveLabel(l))}</small></span>`).join('')
        + meetings.map(mt => `<button type="button" class="event meeting" data-meeting="${meetingIndex(mt)}" title="${esc(mt.title)} — 눌러서 공지문 보기">${fmtM(mt.start)} ${esc(mt.title)}</button>`).join('')
        + '</div>');
    }
    return `<div class="calendar">${DAYS.map(x => `<span class="dow">${x}</span>`).join('')}${cells.join('')}</div>`;
  }

  /* ───────── 오늘 ───────── */

  function chip(p, kind, extra = '') { return `<span class="k-${kind}"${extra ? ` title="${esc(extra)}"` : ''}>${esc(p.name)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>`; }
  function statCard(kind, label, items, empty = '없음') {
    return `<div class="card stat stat-${kind}"><b>${items.length}</b><span><i class="lg lg-${kind}"></i>${label}</span>${items.length ? `<div class="status-tags">${items.join('')}</div>` : `<div class="status-tags empty-tags">${empty}</div>`}</div>`;
  }

  function renderToday() {
    const root = $('#today');
    const head = header('오늘 작업 가능', '지금 함께 작업할 수 있는 사람과 오늘 쉬는 이유까지 한눈에 확인합니다');
    if (!state.hasData) { root.innerHTML = head + placeholder(); return; }
    const now = new Date(), nm = minOf(now), pct = nm / 1440 * 100;
    const longOff = longOffPeople(now);
    const longKeys = new Set(longOff.map(p => p.key));
    const b = { work: [], leave: [], off: [], missing: [], check: [] };
    boardPeople().forEach(p => { if (!longKeys.has(p.key)) { const st = dayStatus(p, now); b[st.kind].push({ p, st }); } });
    const onNow = b.work.filter(x => isAvailable(x.p.key, now, nm, nm + 1));
    const until = l => (l.end > dateKey(now) ? ` ~${fmtShort(l.end)}` : '');

    const cards1 = statCard('work', '오늘 작업 가능', b.work.map(x => chip(x.p, 'work')))
      + statCard('on', '지금 ON', onNow.map(x => chip(x.p, 'on')))
      + statCard('leave', '휴가·개인 일정', b.leave.map(x => chip(x.p, 'leave', leaveLabel(x.st.leave) + until(x.st.leave))))
      + statCard('off', '오늘 작업 불가', b.off.map(x => chip(x.p, 'off')));
    const cards2 = statCard('missing', '스케줄 폼 미제출', b.missing.map(x => chip(x.p, 'missing')))
      + statCard('check', '일정별 확인', b.check.map(x => chip(x.p, 'check')))
      + statCard('long', '장기 OFF', longOff.map(p => { const l = longLeaveOn(p, now); return chip(p, 'long', l ? `${leaveLabel(l)} ~${fmtKey(l.end)}` : ''); }));

    const hours = Array.from({ length: 25 }, (_, h) => `<span class="hour${h === 0 ? ' first' : h === 24 ? ' last' : ''}" style="left:${h / 24 * 100}%">${pad(h)}</span>`).join('');
    const bar = (r, cls, text, tip) => `<span class="bar${cls}" style="--l:${r.start / 1440 * 100}%;--w:${(Math.min(r.end, 1440) - r.start) / 1440 * 100}%" title="${esc(tip)}">${esc(text)}</span>`;
    const workRows = b.work.map(({ p, st }) => {
      const on = onNow.some(x => x.p === p);
      const bars = st.ranges.map(r => bar(r, '', `${fmtM(r.start)}–${fmtM(r.end)}`, `${fmtM(r.start)}–${fmtM(r.end)}`)).join('')
        + st.partials.flatMap(l => (l.kind === 'partial' ? l.ranges : []).map(r => bar(r, ' leave-bar', leaveLabel(l), leaveTip(l)))).join('');
      return `<div class="tl-row"><div class="tl-name"><strong>${esc(p.name)}</strong>${on ? '<span class="on">ON</span>' : ''}<br><small>${esc(p.team || (p.unlisted ? '명단에 없음' : ''))}</small></div><div class="tl-track">${GRID}<i class="now-line" style="--now:${pct}%"></i>${bars}</div></div>`;
    }).join('');
    const leaveRows = b.leave.map(({ p, st }) => `<div class="tl-row is-leave"><div class="tl-name"><strong>${esc(p.name)}</strong><span class="tag-leave">휴가</span><br><small>${esc(p.team)}</small></div><div class="tl-track">${GRID}<i class="now-line" style="--now:${pct}%"></i><span class="band" title="${esc(leaveTip(st.leave))}">${esc(leaveLabel(st.leave) + until(st.leave))}</span></div></div>`).join('');

    root.innerHTML = head
      + `<div class="stats">${cards1}</div><div class="stats stats-3">${cards2}</div>`
      + `<div class="card scroll"><div class="timeline"><div class="tl-head"><div class="tl-name">이름 / 팀</div><div class="tl-hours">${GRID}<span class="now-label" style="--now:${pct}%" id="clock">${clock(now)}</span>${hours}</div></div>${workRows || '<p class="empty">오늘 작업 가능한 사람이 없어요.</p>'}${leaveRows}</div></div>`;
  }

  /* ───────── 이번 주 ───────── */

  function weekDates() { const n = new Date(), sun = addDays(n, -n.getDay()); return Array.from({ length: 7 }, (_, i) => addDays(sun, i)); }

  function cellHtml(st) {
    const parts = (st.partials || []).map(l => `<span class="pill part" title="${esc(leaveTip(l))}">${esc(leaveLabel(l))}${l.kind === 'partial' && l.ranges.length ? `<small>${esc(rangeText(l.ranges))}</small>` : ''}</span>`).join('');
    switch (st.kind) {
      case 'leave': return `<span class="pill leave" title="${esc(leaveTip(st.leave))}">${esc(leaveLabel(st.leave))}</span>`;
      case 'work': return st.ranges.map(r => `<span class="pill">${fmtM(r.start)}–${fmtM(r.end)}</span>`).join('') + parts;
      case 'check': return '<span class="pill check">일정별 확인</span>' + parts;
      case 'missing': return '<span class="pill missing">폼 미제출</span>' + parts;
      default: return '<span class="pill off">작업 불가</span>' + parts;
    }
  }

  function renderWeek() {
    const root = $('#week');
    const head = header('이번 주', '이름을 고정하고 요일별 가능 시간과 쉬는 이유를 한눈에 확인합니다');
    if (!state.hasData) { root.innerHTML = head + placeholder(); return; }
    const ds = weekDates(), today = dateKey(new Date());
    const cls = d => (dateKey(d) === today ? ' class="today"' : '');
    const rows = boardPeople().map(p => `<tr><td><strong>${esc(p.name)}</strong><br><small>${esc(p.team)}</small></td>${ds.map(d => `<td${cls(d)}>${cellHtml(dayStatus(p, d))}</td>`).join('')}</tr>`).join('');
    root.innerHTML = head + LEGEND + `<div class="card scroll"><table class="week-grid"><thead><tr><th>이름</th>${ds.map(d => `<th${cls(d)}>${DAYS[d.getDay()]}<br><small>${d.getMonth() + 1}/${d.getDate()}</small></th>`).join('')}</tr></thead><tbody>${rows || '<tr><td colspan="8" class="empty">표시할 팀원이 없어요.</td></tr>'}</tbody></table></div>`;
  }

  /* ───────── 이번 달 ───────── */

  function renderMonth() {
    const root = $('#month');
    const b = state.month, same = b.getTime() === monthStart(new Date()).getTime();
    const head = header(same ? '이번 달' : `${b.getFullYear()}년 ${b.getMonth() + 1}월`, `${b.getFullYear()}년 ${b.getMonth() + 1}월 휴가·개인 일정과 확정 회의 (회의를 누르면 공지문을 볼 수 있어요)`, monthNav('month', b));
    root.innerHTML = head + (state.hasData ? `<div class="card">${calendarHtml(b)}</div>` : placeholder());
  }

  /* ───────── 참여 인원 고르기 (드롭다운) ───────── */

  function teamsOf(people) {
    const map = new Map();
    people.forEach(p => { const t = p.team || '기타'; if (!map.has(t)) map.set(t, []); map.get(t).push(p.name); });
    return [...map.entries()];
  }

  function pickerHtml(id, selected) {
    const people = boardPeople();
    const extra = selected.filter(n => !people.some(p => p.name === n)).map(n => ({ name: n, team: '기타' }));
    const groups = teamsOf([...people, ...extra]);
    return `<details class="picker" id="${id}Picker"><summary class="picker-toggle"><span class="picker-count">${pickerLabel(selected.length)}</span><i aria-hidden="true">▾</i></summary>
      <div class="picker-panel">
        <div class="picker-actions"><button type="button" class="ghost" data-pick="${id}" data-mode="all">전체 선택</button><button type="button" class="ghost" data-pick="${id}" data-mode="none">전체 취소</button>
          ${groups.length > 1 ? groups.map(([t]) => `<button type="button" class="ghost team-btn" data-pick="${id}" data-mode="team" data-team="${esc(t)}">${esc(t)}</button>`).join('') : ''}</div>
        ${groups.map(([t, names]) => `<fieldset><legend>${esc(t)}</legend>${names.map(n => `<label class="member-check"><input type="checkbox" name="${id}Members" value="${esc(n)}" data-team="${esc(t)}"${selected.includes(n) ? ' checked' : ''}>${esc(n)}</label>`).join('')}</fieldset>`).join('') || '<p class="empty">팀 명단을 불러오면 표시돼요.</p>'}
      </div></details>
      <div class="chips" id="${id}Chips">${chipsHtml(id, selected)}</div>`;
  }
  function pickerLabel(n) { return n ? `${n}명 선택됨` : '참여 인원 선택'; }
  function chipsHtml(id, names) { return names.map(n => `<span class="chip">${esc(n)}<button type="button" data-unpick="${id}" data-name="${esc(n)}" aria-label="${esc(n)} 빼기">×</button></span>`).join(''); }
  function pickedNames(id) { return $$(`[name="${id}Members"]:checked`).map(x => x.value); }
  function syncPicker(id) {
    const names = pickedNames(id);
    const count = $(`#${id}Picker .picker-count`);
    if (count) count.textContent = pickerLabel(names.length);
    const chips = $(`#${id}Chips`);
    if (chips) chips.innerHTML = chipsHtml(id, names);
    if (id === 'mt') state.meetDraft = readMeetForm();
  }

  /* ───────── 회의 ───────── */

  function timeOptions(from, to, selected) {
    const list = [];
    for (let t = from; t <= to; t += 30) list.push(t);
    if (selected !== undefined && !list.includes(selected)) list.push(selected);
    return list.sort((a, b) => a - b).map(t => `<option value="${t}"${t === selected ? ' selected' : ''}>${t === 1440 ? '24:00 (자정)' : fmtM(t)}</option>`).join('');
  }

  function readMeetForm() {
    if (!$('#meetForm')) return null;
    return {
      title: $('#mtTitle').value, names: pickedNames('mt'), place: $('#mtPlace').value,
      length: $('#mtLength').value, step: $('#mtStep').value, from: $('#mtFrom').value, to: $('#mtTo').value,
      dayStart: $('#mtDayStart').value, dayEnd: $('#mtDayEnd').value,
    };
  }

  function applyMeetDraft(d) {
    if (!d) return;
    [['mtTitle', 'title'], ['mtPlace', 'place'], ['mtLength', 'length'], ['mtStep', 'step'], ['mtFrom', 'from'], ['mtTo', 'to'], ['mtDayStart', 'dayStart'], ['mtDayEnd', 'dayEnd']]
      .forEach(([id, k]) => { const el = $('#' + id); if (el && d[k] !== undefined && d[k] !== '') el.value = d[k]; });
  }

  function renderMeet() {
    const root = $('#meet');
    const head = header('회의 시간 찾기', '참여자를 고르면 가능한 시간을 계산하고 바로 확정합니다');
    const draft = readMeetForm() || state.meetDraft;
    const openPicker = $('#mtPicker')?.open;
    if (!state.hasData) { root.innerHTML = head + placeholder(); return; }
    const n = new Date(), today = dateKey(n);
    const mb = state.meetMonth;
    const monthMeetings = state.data.meetings.filter(m => m.date.startsWith(`${mb.getFullYear()}-${pad(mb.getMonth() + 1)}`));
    root.innerHTML = head + `<div class="meet-stack">
      <form id="meetForm" class="card form-card"><div class="meet-grid">
        <div class="field span-6"><label for="mtTitle">회의 이름</label><input id="mtTitle" required placeholder="예: 스토리팀 정기 회의"></div>
        <div class="field span-6"><label for="mtPlace">회의 링크/장소(선택)</label><input id="mtPlace" placeholder="Discord 채널 또는 회의 링크"></div>
        <div class="field span-12"><span class="label">참여 인원</span>${pickerHtml('mt', draft?.names || [])}</div>
        <div class="field span-2"><label for="mtLength">회의 길이(분)</label><input id="mtLength" type="number" min="15" step="5" value="60" required></div>
        <div class="field span-2"><label for="mtStep">후보 간격</label><select id="mtStep"><option value="30">30분</option><option value="15">15분</option><option value="60">1시간</option></select></div>
        <div class="field span-2"><label for="mtFrom">확인 시작일</label><input id="mtFrom" type="date" value="${today}" required></div>
        <div class="field span-2"><label for="mtTo">확인 종료일</label><input id="mtTo" type="date" value="${dateKey(addDays(n, 14))}" required></div>
        <div class="field span-2"><label for="mtDayStart">하루 시작 시간</label><select id="mtDayStart">${timeOptions(0, 1410, 600)}</select></div>
        <div class="field span-2"><label for="mtDayEnd">하루 종료 시간</label><select id="mtDayEnd">${timeOptions(30, 1440, 1440)}</select></div>
        <div class="span-12 form-actions"><button class="primary" type="submit">후보 시간 찾기</button></div>
      </div></form>
      <section id="candidates" class="candidate-wrap"></section>
      <section class="card meet-cal">
        <div class="page-head cal-title"><div><h2>확정 회의 캘린더</h2><p>${mb.getFullYear()}년 ${mb.getMonth() + 1}월 · 회의를 누르면 공지문 다시 보기와 수정을 할 수 있어요</p></div>${monthNav('meet', mb)}</div>
        <div class="meet-cal-body">
          <div class="meet-cal-grid">${calendarHtml(mb)}</div>
          <aside class="month-meetings"><h3>${mb.getMonth() + 1}월 회의 <small>${monthMeetings.length}건</small></h3>
            ${monthMeetings.map(m => `<button type="button" class="meeting-item${m.date < today ? ' past' : ''}" data-meeting="${meetingIndex(m)}"><span class="mi-date">${esc(fmtDate(keyToDate(m.date)))} ${fmtM(m.start)}–${fmtM(Math.min(m.end, 1440))}</span><strong>${esc(m.title)}</strong><small>${m.members.length ? `${m.members.length}명 · ${esc(m.members.slice(0, 4).join(', '))}${m.members.length > 4 ? ' 외' : ''}` : '참석자 정보 없음'}</small></button>`).join('') || '<p class="empty">이 달에 확정된 회의가 없어요.</p>'}
          </aside>
        </div>
      </section>
    </div>`;
    applyMeetDraft(draft);
    if (openPicker) $('#mtPicker').open = true;
    renderCandidates();
  }

  function meetingOverlap(date, s, e) { const k = dateKey(date); return state.data.meetings.some(m => m.date === k && m.start < e && m.end > s); }

  function findCandidates() {
    const d = readMeetForm();
    state.meetDraft = d;
    if (!d.names.length) return showNotice('참여 인원을 한 명 이상 골라 주세요.', 'error');
    const from = keyToDate(d.from), to = keyToDate(d.to);
    if (!from || !to) return showNotice('확인할 기간을 정해 주세요.', 'error');
    if (to < from) return showNotice('확인 종료일이 시작일보다 빠를 수 없어요.', 'error');
    if (daysBetween(d.from, d.to) > 62) return showNotice('확인 기간은 두 달(62일) 안으로 정해 주세요.', 'error');
    const duration = +d.length, step = +d.step, dayStart = +d.dayStart, dayEnd = +d.dayEnd;
    if (!(duration >= 15)) return showNotice('회의 길이는 15분 이상이어야 해요.', 'error');
    if (dayEnd - dayStart < duration) return showNotice('하루 시작~종료 시간 사이가 회의 길이보다 짧아요.', 'error');
    hideNotice();
    $('#mtPicker').open = false;
    const list = [];
    for (let day = new Date(from); day <= to; day = addDays(day, 1)) {
      for (let s = dayStart; s + duration <= dayEnd; s += step) {
        if (meetingOverlap(day, s, s + duration)) continue;
        const who = slotPeople(d.names, day, s, s + duration);
        if (who.ok.length || !who.checkable) list.push({ title: d.title.trim() || '회의', date: dateKey(day), start: s, end: s + duration, members: d.names, place: d.place.trim(), ...who });
      }
    }
    list.sort((a, b) => b.ok.length - a.ok.length || (a.date + pad(a.start)).localeCompare(b.date + pad(b.start)));
    state.meetResult = list;
    state.showAllCand = false;
    renderCandidates();
    $('#candidates').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 한 시간대에 참여 인원 한 명 한 명이 되는지, 안 되면 왜 안 되는지
  function slotPeople(names, day, s, e) {
    const k = dateKey(day);
    const ok = [], no = [], unknown = [];
    names.forEach(nm => {
      const p = personByName(nm);
      if (!p) { unknown.push({ name: nm, why: '명단에 없음' }); return; }
      const ls = leavesOn(p.key, k);
      const full = ls.find(l => l.kind === 'full');
      if (full) { no.push({ name: nm, why: leaveLabel(full), kind: 'leave' }); return; }
      if (isAvailable(p.key, day, s, e)) { ok.push({ name: nm }); return; }
      if (baseKind(p) === 'check') { unknown.push({ name: nm, why: '일정별 확인' }); return; }
      if (!hasSchedule(p)) { unknown.push({ name: nm, why: '폼 미제출' }); return; }
      const part = ls.find(l => l.kind === 'partial' && l.ranges.some(r => r.start < e && r.end > s));
      if (part) { no.push({ name: nm, why: leaveLabel(part), kind: 'leave' }); return; }
      const r = rangesFor(p.key, day);
      no.push({ name: nm, why: r.length ? `${rangeText(r)}만 가능` : '작업 불가', kind: 'off' });
    });
    return { ok, no, unknown, checkable: ok.length + no.length };
  }

  function whoRow(label, cls, list) {
    if (!list.length) return '';
    return `<div class="cand-row"><span class="cand-label ${cls}">${label} ${list.length}</span><div class="cand-chips">${list.map(x => `<span class="${cls}${x.kind ? ' ' + x.kind : ''}">${esc(x.name)}${x.why ? `<small>${esc(x.why)}</small>` : ''}</span>`).join('')}</div></div>`;
  }

  function renderCandidates() {
    const box = $('#candidates');
    if (!box) return;
    const list = state.meetResult;
    if (!list) { box.innerHTML = ''; return; }
    if (!list.length) { box.innerHTML = '<div class="card empty">선택한 조건에서 가능한 시간이 없어요. 기간이나 시간을 넓혀보세요.</div>'; return; }
    const shown = list.slice(0, state.showAllCand ? 30 : 8);
    const f = state.features;
    const opts = f.discord
      ? `<label class="notify-opt"><input type="checkbox" data-notify${state.notifyDiscord ? ' checked' : ''}> 확정하면 디스코드에 공지 올리기</label>`
      : '';
    const hint = f.discord && f.calendar ? '확정하면 구글 캘린더에도 자동으로 추가돼요.'
      : f.calendar ? '확정하면 구글 캘린더에도 자동으로 추가돼요. 디스코드 자동 공지는 관리용 Apps Script에 웹후크 주소를 넣으면 켜져요.'
      : '디스코드 자동 공지와 구글 캘린더 자동 추가는 관리용 연결을 설정하면 켜져요.';
    box.innerHTML = `<div class="cand-top"><h2 class="section-title">후보 시간 <small>${list.length}개 · 되는 사람이 많은 순</small></h2>${opts}</div><p class="cand-hint">${hint}</p><div class="candidate-list">`
      + shown.map((x, i) => {
        const total = x.ok.length + x.no.length;
        const sum = !total ? '스케줄 정보가 있는 사람이 없어요'
          : x.ok.length === total ? `<b class="all-ok">가능한 사람 전원 참석 (${total}명)</b>` : `<b>${total}명 중 ${x.ok.length}명 가능</b>`;
        return `<article class="candidate cand-v2"><div class="cand-head"><div><strong>${esc(fmtDate(keyToDate(x.date)))} ${fmtM(x.start)}–${fmtM(x.end)}</strong><span class="cand-sum">${sum}</span></div><button class="primary" data-fix="${i}" type="button">이 시간 확정</button></div>`
          + `<div class="cand-rows">${whoRow('가능', 'ok', x.ok)}${whoRow('불가', 'no', x.no)}${whoRow('확인 필요', 'unknown', x.unknown)}</div></article>`;
      }).join('') + '</div>'
      + (!state.showAllCand && list.length > 8 ? `<button type="button" class="ghost more-cand" data-more-cand>후보 더 보기 (${Math.min(list.length, 30) - 8}개 더)</button>` : '');
  }

  function meetingPayload(m) {
    const endDate = m.end >= 1440 ? dateKey(addDays(keyToDate(m.date), 1)) : m.date;
    return {
      '회의명': m.title, '시작 일시': `${m.date} ${fmtM(m.start)}`, '종료 일시': `${endDate} ${fmtM(m.end % 1440)}`,
      '참석자': m.members.join(', '),
      '관련 팀': [...new Set(m.members.map(nm => personByName(nm)?.team).filter(Boolean))].join(', ') || '전체',
      '회의 링크/장소': m.place || '', '상태': '확정',
    };
  }
  function findMeeting(x) { return state.data.meetings.find(m => m.title === x.title && m.date === x.date && m.start === x.start); }

  async function confirmMeeting(x, btn) {
    const pass = await askPassword('회의를 확정하려면 관리 비밀번호를 입력해 주세요.');
    if (!pass) return;
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      const payload = meetingPayload(x);
      const json = await adminRequest({ action: 'create', pass, ...notifyFields(x, 'created') }, { meeting: payload });
      state.adminPass = pass;
      applyResponse(json, { meeting: { title: x.title, start: payload['시작 일시'], end: payload['종료 일시'], members: payload['참석자'], place: x.place, status: '확정' } });
      state.meetResult = null;
      renderMeet(); renderMonth();
      openMeeting(findMeeting(x) || { ...x }, 'created', json);
    } catch (e) {
      passFailed(e);
      btn.disabled = false; btn.textContent = '이 시간 확정';
      showNotice(e.message, 'error');
    }
  }

  /* ───────── 회의 상세 (공지문 다시 보기 · 수정 · 취소) ───────── */

  // 구글 캘린더 '일정 추가' 화면을 미리 채워서 여는 주소 (누구나 자기 캘린더에 추가할 수 있어요)
  function gcalUrl(m) {
    const t = n => `${pad(Math.floor((n % 1440) / 60))}${pad(n % 60)}00`;
    const d1 = m.date.replace(/-/g, '');
    const d2 = (m.end >= 1440 ? dateKey(addDays(keyToDate(m.date), 1)) : m.date).replace(/-/g, '');
    const q = new URLSearchParams({ action: 'TEMPLATE', text: m.title, dates: `${d1}T${t(m.start)}/${d2}T${t(m.end)}`, ctz: 'Asia/Seoul', details: `참석자: ${m.members.join(', ') || '-'}` });
    if (m.place) q.set('location', m.place);
    return 'https://calendar.google.com/calendar/render?' + q.toString();
  }

  // 디스코드로 보낼 글 (공지문 + 캘린더 추가 링크)
  function discordText(m, kind) {
    return noticeText(m, kind) + (kind === 'canceled' ? '' : `\n📆 [내 구글 캘린더에 추가](${gcalUrl(m)})`);
  }
  function notifyFields(m, kind) {
    const on = !!state.features.discord && state.notifyDiscord;
    return { notify: on, notice: on ? discordText(m, kind) : '' };
  }

  function noticeText(m, kind) {
    const d = keyToDate(m.date);
    const when = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일(${DAYS[d.getDay()]}) ${fmtM(m.start)}~${fmtM(Math.min(m.end, 1440))}`;
    if (kind === 'canceled') return `📅 ${m.title} 취소 안내\n\n${when}에 예정됐던 회의가 취소되었습니다.\n\n확인 부탁드립니다!`;
    return `📅 ${kind === 'updated' ? '[일정 변경] ' : ''}${m.title} 안내\n\n일시: ${when}\n참석자: ${m.members.join(', ') || '-'}${m.place ? `\n회의 링크/장소: ${m.place}` : ''}\n\n확인 부탁드립니다!`;
  }

  function resultText(json) {
    if (!json) return '';
    const bits = [];
    if (json.done?.discord) bits.push('디스코드에 공지를 올렸어요.');
    if (json.done?.calendar === 'saved') bits.push('구글 캘린더에 반영했어요.');
    if (json.done?.calendar === 'deleted') bits.push('구글 캘린더에서 지웠어요.');
    return bits.join(' ');
  }

  function openMeeting(m, kind = 'view', json = null) {
    state.dlg = { meeting: m, mode: 'view', kind, extra: resultText(json), warnings: json?.warnings || [] };
    renderMeetingDialog();
    const d = $('#meetingDialog');
    if (!d.open) d.showModal();
  }

  function renderMeetingDialog() {
    const { meeting: m, mode, kind } = state.dlg;
    const d = $('#meetingDialog');
    const x = '<button type="button" class="dlg-x" data-dlg="close" aria-label="닫기">×</button>';
    const err = '<p class="dlg-error" id="dlgError" hidden></p>';
    if (mode === 'edit') {
      d.innerHTML = `<form id="editForm"><div class="dlg-head"><div><h2>회의 수정</h2><p>${esc(m.title)}</p></div>${x}</div>
        <div class="dlg-body form-grid">
          <div class="field full"><label for="edTitle">회의 이름</label><input id="edTitle" required value="${esc(m.title)}"></div>
          <div class="field full"><label for="edDate">날짜</label><input id="edDate" type="date" required value="${m.date}"></div>
          <div class="field"><label for="edStart">시작</label><select id="edStart">${timeOptions(0, 1410, m.start)}</select></div>
          <div class="field"><label for="edEnd">종료</label><select id="edEnd">${timeOptions(30, 1440, Math.min(m.end, 1440))}</select></div>
          <div class="field full"><span class="label">참석자</span>${pickerHtml('ed', m.members)}</div>
          <div class="field full"><label for="edPlace">회의 링크/장소</label><input id="edPlace" value="${esc(m.place || '')}"></div>
          ${state.features.discord ? `<label class="notify-opt full"><input type="checkbox" data-notify${state.notifyDiscord ? ' checked' : ''}> 바뀐 내용을 디스코드에 공지하기</label>` : ''}
        </div>${err}
        <div class="dlg-foot"><button type="button" class="ghost" data-dlg="view">돌아가기</button><span class="grow"></span><button type="submit" class="primary">수정 저장</button></div></form>`;
      return;
    }
    const base = { created: '회의를 확정 회의 캘린더에 저장했어요.', updated: '회의를 수정했어요. 바뀐 내용으로 공지문을 다시 만들었어요.', canceled: '회의를 취소했어요. 확정 회의 캘린더에서 빠졌어요.' }[kind];
    const msg = base ? `${base} ${state.dlg.extra || (state.features.discord ? '' : '공지문을 복사해서 팀에 보내 주세요.')}`.trim() : '';
    const warns = (state.dlg.warnings || []).map(w => `<p class="dlg-warn">${esc(w)}</p>`).join('');
    const canEdit = !!ADMIN_URL && kind !== 'canceled';
    const f = state.features;
    d.innerHTML = `<div class="dlg-head"><div><h2>${esc(m.title)}</h2><p>${esc(fmtDate(keyToDate(m.date)))} ${fmtM(m.start)}–${fmtM(Math.min(m.end, 1440))}</p></div>${x}</div>
      <div class="dlg-body">
        ${msg ? `<p class="dlg-ok">${esc(msg)}</p>` : ''}${warns}
        <dl class="dlg-info"><div><dt>참석자</dt><dd>${esc(m.members.join(', ') || '-')}</dd></div><div><dt>링크/장소</dt><dd>${esc(m.place || '-')}</dd></div></dl>
        <label class="label" for="dlgNotice">${kind === 'canceled' ? '취소 공지문' : '공지문'}</label>
        <textarea id="dlgNotice" readonly>${esc(noticeText(m, kind))}</textarea>
        <div class="dlg-tools">
          ${kind === 'canceled' ? '' : `<a class="ghost tool-btn" href="${esc(gcalUrl(m))}" target="_blank" rel="noopener">📆 내 구글 캘린더에 추가</a>`}
          ${f.discord ? '<button type="button" class="ghost tool-btn" data-dlg="discord">디스코드로 공지 보내기</button>' : ''}
          <span class="grow"></span><button type="button" class="primary" data-copy="#dlgNotice">공지문 복사</button>
        </div>
        ${canEdit && f.discord ? `<label class="notify-opt"><input type="checkbox" data-notify${state.notifyDiscord ? ' checked' : ''}> 수정·취소하면 디스코드에도 알리기</label>` : ''}
      </div>${err}
      ${kind === 'canceled' ? '' : `<div class="dlg-foot"><button type="button" class="ghost" data-dlg="edit"${canEdit ? '' : ' disabled'}>회의 수정</button><button type="button" class="ghost danger" data-dlg="cancel"${canEdit ? '' : ' disabled'}>회의 취소</button></div>`}
      ${!ADMIN_URL && kind !== 'canceled' ? '<p class="dlg-hint">회의 수정·취소와 디스코드 자동 공지는 관리용 연결을 한 번 설정하면 켜져요. 그 전까지는 공지문 복사와 캘린더 추가만 쓸 수 있어요.</p>' : ''}`;
  }

  function dlgError(msg) {
    const el = $('#dlgError');
    if (el && $('#meetingDialog').open) { el.textContent = msg; el.hidden = !msg; } else showNotice(msg, 'error');
  }

  function originalOf(m) { return { title: m.rawTitle ?? m.title, rawStart: m.rawStart, date: m.date, start: fmtM(m.start) }; }

  async function saveEdit() {
    const m = state.dlg.meeting;
    const upd = { title: $('#edTitle').value.trim(), date: $('#edDate').value, start: +$('#edStart').value, end: +$('#edEnd').value, members: pickedNames('ed'), place: $('#edPlace').value.trim() };
    if (!upd.title || !upd.date) return dlgError('회의 이름과 날짜를 적어 주세요.');
    if (upd.end <= upd.start) return dlgError('종료 시간이 시작 시간보다 늦어야 해요.');
    if (!upd.members.length) return dlgError('참석자를 한 명 이상 골라 주세요.');
    const pass = await askPassword('회의를 수정하려면 관리 비밀번호를 입력해 주세요.');
    if (!pass) return;
    const btn = $('#editForm [type="submit"]');
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      const json = await adminRequest({ action: 'meeting_update', pass, id: m.id, original: originalOf(m), ...notifyFields(upd, 'updated') }, { meeting: meetingPayload(upd) });
      state.adminPass = pass;
      applyResponse(json);
      renderMeet(); renderMonth();
      openMeeting(findMeeting(upd) || { ...m, ...upd }, 'updated', json);
    } catch (e) {
      passFailed(e);
      btn.disabled = false; btn.textContent = '수정 저장';
      dlgError(e.message);
    }
  }

  async function cancelMeeting() {
    const m = state.dlg.meeting;
    if (!confirm(`'${m.title}' 회의를 취소할까요? 확정 회의 캘린더에서 빠져요.`)) return;
    const pass = await askPassword('회의를 취소하려면 관리 비밀번호를 입력해 주세요.');
    if (!pass) return;
    try {
      const json = await adminRequest({ action: 'meeting_cancel', pass, id: m.id, original: originalOf(m), ...notifyFields(m, 'canceled') });
      state.adminPass = pass;
      applyResponse(json);
      renderMeet(); renderMonth();
      openMeeting(m, 'canceled', json);
    } catch (e) { passFailed(e); dlgError(e.message); }
  }

  async function sendDiscord(btn) {
    const { meeting: m, kind } = state.dlg;
    const pass = await askPassword('디스코드에 공지를 보내려면 관리 비밀번호를 입력해 주세요.');
    if (!pass) return;
    btn.disabled = true; btn.textContent = '보내는 중…';
    try {
      await adminRequest({ action: 'notify', pass, notice: discordText(m, kind === 'canceled' ? 'canceled' : kind === 'updated' ? 'updated' : 'view') });
      state.adminPass = pass;
      btn.textContent = '디스코드에 보냈어요';
    } catch (e) {
      passFailed(e);
      btn.disabled = false; btn.textContent = '디스코드로 공지 보내기';
      dlgError(e.message);
    }
  }

  /* ───────── 팀 명단 (관리자) ───────── */

  function renderTeam() {
    const root = $('#team');
    if (!state.adminUnlocked) {
      root.innerHTML = header('팀 명단', '관리자만 확인할 수 있습니다') + '<form id="teamUnlock" class="card unlock-card"><h2 class="section-title">관리자 확인</h2><p>관리 비밀번호를 입력하면 팀 상태와 명단을 볼 수 있어요.</p><input id="teamPass" type="password" autocomplete="current-password" required placeholder="관리 비밀번호" aria-label="관리 비밀번호"><button class="primary" type="submit">팀 명단 열기</button></form>';
      return;
    }
    const lock = '<button id="lockTeam" class="ghost" type="button">잠그기</button>';
    if (!state.hasData) { root.innerHTML = header('팀 명단', '현재 팀 상태와 일정 확인 방법을 구분해 확인합니다', lock) + placeholder(); return; }
    const now = new Date();
    const longOff = new Set(longOffPeople(now).map(p => p.key));
    const groups = [
      ['활동 중', p => baseKind(p) === 'active' && !longOff.has(p.key)],
      ['일정별 확인', p => baseKind(p) === 'check' && !longOff.has(p.key)],
      ['장기 OFF', p => longOff.has(p.key)],
      ['빠진 멤버', p => baseKind(p) === 'left'],
    ];
    const row = p => {
      const badges = [];
      if (isMissing(p) && !longOff.has(p.key)) badges.push('<b class="missing">폼 미제출</b>');
      if (p.unlisted) badges.push('<b class="missing">명단에 없음</b>');
      const ll = longLeaveOn(p, now);
      if (ll) badges.push(`<b class="until">~${esc(fmtKey(ll.end))}</b>`);
      return `<div class="person"><strong>${esc(p.name)}</strong><small>${badges.join(' ')} ${esc(p.team)}</small></div>`;
    };
    root.innerHTML = header('팀 명단', '현재 팀 상태와 일정 확인 방법을 구분해 확인합니다', lock)
      + `<div class="team-groups">${groups.map(([name, fn]) => `<section class="card team-group"><h2 class="section-title">${name}</h2>${state.data.team.filter(fn).map(row).join('') || '<p class="empty">해당 인원이 없어요.</p>'}</section>`).join('')}</div>`;
  }

  async function unlock() {
    const input = $('#teamPass');
    const pass = input.value;
    try {
      await adminRequest({ action: 'auth', pass });
      state.adminUnlocked = true;
      state.adminPass = pass;
      session.set('metroAdminUnlocked', '1');
      showNotice('관리자 확인이 끝났어요.', 'ok');
      renderTeam(); renderLinks();
    } catch (err) { showNotice(err.message, 'error'); input.select(); }
  }

  function lockAdmin() {
    state.adminUnlocked = false;
    state.adminPass = '';
    session.del('metroAdminUnlocked');
    renderTeam(); renderLinks();
  }

  /* ───────── 링크 허브 ───────── */

  function readLinkDraft() {
    if (!$('#linkForm')) return null;
    return { title: $('#linkTitle').value, url: $('#linkUrl').value, memo: $('#linkMemo').value };
  }

  function renderLinks() {
    const root = $('#links');
    const draft = readLinkDraft() || state.linkDraft;
    const builtins = [
      state.adminUnlocked ? { title: '출근판 관리자 시트', url: C.SHEET_URL, memo: '관리자 전용' } : null,
      { title: '작업 가능 시간 입력', url: C.WORK_FORM_URL },
      { title: '휴가·외부 일정 입력', url: C.LEAVE_FORM_URL },
    ].filter(x => x && x.url);
    const custom = state.data.links || [];
    root.innerHTML = header('링크 허브', '팀 운영에 자주 쓰는 링크를 모아둬요. 추가하거나 지울 때는 관리 비밀번호가 필요해요.', `<button type="button" class="primary" data-link-add${state.linkFormOpen ? ' hidden' : ''}>＋ 링크 추가</button>`)
      + `<form id="linkForm" class="card link-form"${state.linkFormOpen ? '' : ' hidden'}><h2 class="section-title">새 링크</h2><div class="form-grid">
          <div class="field"><label for="linkTitle">링크 이름</label><input id="linkTitle" required placeholder="예: 디스코드"></div>
          <div class="field"><label for="linkUrl">주소</label><input id="linkUrl" type="url" required placeholder="https://"></div>
          <div class="field full"><label for="linkMemo">설명(선택)</label><input id="linkMemo" placeholder="어떤 링크인지 짧게 적어 주세요"></div>
          <div class="field full form-actions"><button type="button" class="ghost" data-link-cancel>닫기</button><button class="primary" type="submit">링크 저장</button></div>
        </div></form>`
      + `<div class="links">${builtins.map(x => `<a class="card link-card" href="${esc(x.url)}" target="_blank" rel="noopener"><strong>${esc(x.title)}</strong><span>${esc(x.memo || '새 창에서 열기 →')}</span><em class="link-tag">기본</em></a>`).join('')}`
      + custom.map(x => `<article class="card link-card custom-link"><a href="${esc(x.url)}" target="_blank" rel="noopener"><strong>${esc(x.title)}</strong><span>${esc(x.memo || '새 창에서 열기 →')}</span></a><button type="button" class="link-delete" data-link-delete="${esc(x.id)}" aria-label="${esc(x.title)} 삭제">삭제</button></article>`).join('')
      + '</div>'
      + (custom.length ? '' : '<p class="links-empty">아직 직접 추가한 링크가 없어요. 오른쪽 위 "링크 추가"로 등록할 수 있어요.</p>');
    if (draft && state.linkFormOpen) {
      $('#linkTitle').value = draft.title || '';
      $('#linkUrl').value = draft.url || '';
      $('#linkMemo').value = draft.memo || '';
    }
  }

  async function saveLink() {
    const d = readLinkDraft();
    const pass = await askPassword('링크를 추가하려면 관리 비밀번호를 입력해 주세요.');
    if (!pass) return;
    const link = { title: d.title.trim(), url: d.url.trim(), memo: d.memo.trim() };
    try {
      const json = await adminRequest({ action: 'link_create', pass }, { link });
      state.adminPass = pass;
      applyResponse(json, { link });
      state.linkDraft = null;
      state.linkFormOpen = false;
      showNotice('링크를 추가했어요.', 'ok');
      renderLinks();
    } catch (err) { passFailed(err); showNotice(err.message, 'error'); }
  }

  async function deleteLink(id) {
    const link = state.data.links.find(x => x.id === id);
    if (!confirm(`'${link ? link.title : '이 링크'}' 링크를 삭제할까요?`)) return;
    const pass = await askPassword('링크를 삭제하려면 관리 비밀번호를 입력해 주세요.');
    if (!pass) return;
    try {
      const json = await adminRequest({ action: 'link_delete', pass, id });
      state.adminPass = pass;
      applyResponse(json, { removeLink: id });
      showNotice('링크를 삭제했어요.', 'ok');
      renderLinks();
    } catch (err) { passFailed(err); showNotice(err.message, 'error'); }
  }

  /* ───────── 관리 비밀번호 창 ───────── */

  let passResolve = null;
  function askPassword(msg) {
    if (state.adminPass) return Promise.resolve(state.adminPass);
    const dlg = $('#passDialog');
    $('#passMsg').textContent = msg;
    $('#passInput').value = '';
    dlg.showModal();
    $('#passInput').focus();
    return new Promise(res => { passResolve = res; });
  }
  function closePass(value) {
    const r = passResolve;
    passResolve = null;
    const dlg = $('#passDialog');
    if (dlg.open) dlg.close();
    if (r) r(value);
  }
  function passFailed(e) { if (/비밀번호|password/i.test(e.message)) state.adminPass = ''; }

  /* ───────── 연결 상태 창 (오른쪽 위 점을 누르면 열려요) ───────── */

  function srcText(s) {
    return { ok: '연결됨', error: `연결 안 됨 — ${s.error}`, off: '설정 전', idle: '확인 중', empty: '읽었지만 내용 없음' }[s.status] || s.status;
  }

  function renderDiag() {
    const d = state.data;
    const unlisted = d.team.filter(p => p.unlisted).map(p => p.name);
    const unreadable = [...new Set(d.availability.filter(a => a.unreadable).map(a => a.name))];
    const cell = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const warns = [];
    if (state.hasData && !state.idx.avail.size) warns.push('근무시간 데이터가 하나도 들어오지 않았어요. 기본 연결(API_URL)이 근무시간을 보내주지 않거나, 형식을 읽지 못하고 있어요.');
    if (state.hasData && !d.leaves.length) warns.push('휴가·개인 일정이 하나도 들어오지 않았어요. 관리용 연결(ADMIN_API_URL)을 설정하면 [휴가일정 응답] 탭을 직접 읽어와요.');
    if (unlisted.length) warns.push(`명단에 없는 이름이 폼에 있어요: ${unlisted.join(', ')}. 폼에 적은 이름과 명단 이름이 다르면 이렇게 표시돼요.`);
    if (unreadable.length) warns.push(`근무 시간을 읽지 못한 사람이 있어요: ${unreadable.join(', ')}. "14:00-18:00"처럼 적혀 있는지 확인해 주세요.`);
    $('#diagDialog').innerHTML = `<div class="dlg-head"><div><h2>시트 연결 상태</h2><p>${state.lastSync ? `마지막으로 불러온 시각 ${clock(state.lastSync)}` : '아직 불러오지 못했어요'}</p></div><button type="button" class="dlg-x" data-dlg-close="diagDialog" aria-label="닫기">×</button></div>
      <div class="dlg-body">
        <dl class="src-list">
          <div><dt>기본 연결 <small>(명단·근무시간)</small></dt><dd data-state="${state.src.main.status}">${esc(srcText(state.src.main))}</dd></div>
          <div><dt>관리용 연결 <small>(휴가·회의·링크)</small></dt><dd data-state="${state.src.admin.status}">${esc(srcText(state.src.admin))}</dd></div>
          ${state.src.sheet.status !== 'off' ? `<div><dt>시트 직접 읽기 <small>(휴가 대체)</small></dt><dd data-state="${state.src.sheet.status}">${esc(srcText(state.src.sheet))}</dd></div>` : ''}
        </dl>
        <dl class="diag-grid">${cell('명단', `${d.team.length}명`)}${cell('근무시간 제출', `${state.idx.avail.size}명`)}${cell('휴가·개인 일정', `${d.leaves.length}건`)}${cell('확정 회의', `${d.meetings.length}건`)}${cell('추가 링크', `${d.links.length}개`)}</dl>
        ${state.leaveSource ? `<p class="diag-note">휴가·개인 일정은 ${state.leaveSource}에서 가져왔어요.</p>` : ''}
        ${warns.map(w => `<p class="diag-warn">${esc(w)}</p>`).join('')}
        <p class="diag-note">화면이 이상하면 아래 버튼을 눌러 복사한 내용을 Claude에게 그대로 붙여 넣어 주세요. 시트가 어떤 모양으로 데이터를 보내는지 바로 확인할 수 있어요.</p>
      </div>
      <div class="dlg-foot"><span class="grow"></span><button type="button" class="primary" data-copy-diag>받은 데이터 복사</button></div>`;
  }

  async function copyDiag(btn) {
    btn.disabled = true; btn.textContent = '모으는 중…';
    const sample = obj => {
      if (!obj) return null;
      const o = {};
      Object.keys(obj).forEach(k => { const v = obj[k]; o[k] = Array.isArray(v) ? { count: v.length, first: v.slice(0, 3) } : v; });
      return o;
    };
    let debug = null;
    if (ADMIN_URL) {
      try { debug = (await getJson(`${ADMIN_URL}${ADMIN_URL.includes('?') ? '&' : '?'}debug=1`)).debug || null; }
      catch (e) { debug = '확인용 데이터를 받지 못함: ' + e.message; }
    }
    const payload = {
      version: VERSION, time: new Date().toString(), sources: state.src, leaveSource: state.leaveSource,
      counts: { team: state.data.team.length, availabilityPeople: state.idx.avail.size, leaves: state.data.leaves.length, meetings: state.data.meetings.length, links: state.data.links.length },
      main: sample(state.raw.main), admin: sample(state.raw.admin), sheetLeaves: state.raw.sheetLeaves ? state.raw.sheetLeaves.slice(0, 3) : null, sheetTabs: debug,
    };
    btn.disabled = false;
    await copyText(JSON.stringify(payload, null, 1), btn, '받은 데이터 복사');
  }

  /* ───────── 시트와 주고받기 ───────── */

  async function getJson(url, opts) {
    let res;
    try { res = await fetch(url, opts || { cache: 'no-store' }); }
    catch { throw new Error('연결 주소에 접속하지 못했어요. Apps Script가 "모든 사용자"에게 공개로 배포됐는지, config.js의 주소가 최신 배포 주소인지 확인해 주세요.'); }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`연결 주소가 데이터 대신 다른 화면을 보내왔어요(응답 코드 ${res.status}). config.js의 주소가 지금 배포된 주소와 같은지, 배포 액세스 권한이 "모든 사용자"인지 확인해 주세요.`); }
    if (!json.ok) throw new Error(json.error || '시트가 데이터를 보내주지 않았어요.');
    return json;
  }

  // 쓰기 요청은 관리용 연결이 있으면 그쪽으로, 없으면 기본 연결로 보내요
  function adminRequest(body, extra = {}) {
    const url = ADMIN_URL || MAIN_URL;
    if (!url) return Promise.reject(new Error('config.js에 Apps Script 웹 앱 주소를 입력해 주세요.'));
    return getJson(url, { method: 'POST', body: JSON.stringify({ ...body, ...extra }) });
  }

  // 쓰기 뒤 돌아온 최신 데이터를 반영해요 (예전 Apps Script가 목록을 안 돌려주면 화면에 직접 더해요)
  function applyResponse(json, patch = {}) {
    if (json && json.source === 'admin') {
      state.raw.admin = { ...(state.raw.admin || {}), ...json };
    } else {
      const main = state.raw.main = state.raw.main || {};
      if (Array.isArray(json?.meetings)) main.meetings = json.meetings;
      else if (patch.meeting) main.meetings = [...(Array.isArray(main.meetings) ? main.meetings : []), patch.meeting];
      if (Array.isArray(json?.links)) main.links = json.links;
      else if (patch.link) main.links = [...(Array.isArray(main.links) ? main.links : []), { id: patch.link.url, ...patch.link }];
      else if (patch.removeLink) main.links = (main.links || []).filter(l => String(pick(l, 'id') || pick(l, 'url')) !== patch.removeLink);
    }
    recompute();
  }

  // [휴가일정 응답] 탭을 시트에서 바로 읽어요 (시트가 '링크가 있는 사용자 보기'일 때만 가능)
  async function readLeaveTab() {
    const id = (/\/d\/([\w-]+)/.exec(C.SHEET_URL || '') || [])[1];
    if (!id) throw new Error('config.js의 SHEET_URL이 비어 있어요.');
    let res;
    try { res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(LEAVE_TAB)}`, { cache: 'no-store' }); }
    catch { throw new Error('시트를 직접 읽지 못했어요.'); }
    const m = /setResponse\(([\s\S]*)\)\s*;?\s*$/.exec(await res.text());
    if (!m) throw new Error('시트를 직접 읽지 못했어요. 시트 공유가 잠겨 있을 수 있어요.');
    const t = JSON.parse(m[1]);
    if (t.status !== 'ok') throw new Error('시트를 직접 읽지 못했어요.');
    const heads = t.table.cols.map(c => String(c.label || '').trim());
    return t.table.rows.map(r => {
      const o = {};
      heads.forEach((h, i) => { const c = r.c?.[i]; if (h) o[h] = c ? (c.f ?? c.v ?? '') : ''; });
      return o;
    }).filter(o => pick(o, '이름'));
  }

  async function load({ quiet = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!quiet) setSync('loading', '<span class="sync-word">불러오는 중</span>');
    try {
      if (!MAIN_URL && !ADMIN_URL) throw new Error('config.js에 Apps Script 웹 앱 주소를 입력해 주세요.');
      const [m, a] = await Promise.allSettled([MAIN_URL ? getJson(MAIN_URL) : null, ADMIN_URL ? getJson(ADMIN_URL) : null]);
      if (MAIN_URL) {
        if (m.status === 'fulfilled') { state.raw.main = m.value; state.src.main = { status: 'ok', error: '' }; }
        else state.src.main = { status: 'error', error: m.reason.message };
      }
      if (ADMIN_URL) {
        if (a.status === 'fulfilled') { state.raw.admin = a.value; state.src.admin = { status: 'ok', error: '' }; }
        else state.src.admin = { status: 'error', error: a.reason.message };
      }
      const results = [state.src.main, state.src.admin].filter(s => s.status !== 'off');
      if (!results.some(s => s.status === 'ok')) throw new Error(results.map(s => s.error).find(Boolean) || '시트를 불러오지 못했어요.');
      recompute();
      // 휴가가 하나도 안 들어오면, 관리용 연결이 없을 때에 한해 시트 탭을 직접 읽어봐요
      if (!state.data.leaves.length && state.src.admin.status !== 'ok') {
        try {
          state.raw.sheetLeaves = await readLeaveTab();
          state.src.sheet = { status: state.raw.sheetLeaves.length ? 'ok' : 'empty', error: '' };
        } catch (e) { state.src.sheet = { status: 'error', error: e.message }; }
        recompute();
      }
      state.hasData = true;
      state.lastSync = new Date();
      state.syncError = '';
      const partial = results.some(s => s.status === 'error');
      setSync(partial ? 'warn' : 'ok', `<span class="sync-word">${partial ? '일부만 연결됨' : '시트 연결됨'}</span> ${hhmm(state.lastSync)}`, partial ? '누르면 어느 쪽이 끊겼는지 볼 수 있어요' : '1분마다 자동으로 다시 불러와요. 누르면 연결 상태를 볼 수 있어요');
      if ($('#notice').dataset.tone === 'error') hideNotice();
      renderAll();
    } catch (e) {
      state.syncError = e.message;
      setSync('error', '연결 안 됨', e.message);
      if (state.hasData) showNotice('시트를 다시 불러오지 못해서 마지막으로 받은 내용을 보여주고 있어요. ' + e.message, 'error');
      else renderAll();
    } finally {
      state.loading = false;
      if ($('#diagDialog').open) renderDiag();
    }
  }

  function setSync(kind, html, title = '') {
    const el = $('#syncStatus');
    if (!el) return;
    el.dataset.state = kind;
    el.innerHTML = html;
    el.title = title;
  }

  let noticeTimer;
  function showNotice(msg, tone = 'info') {
    const n = $('#notice');
    clearTimeout(noticeTimer);
    n.textContent = msg;
    n.dataset.tone = msg ? tone : '';
    n.hidden = !msg;
    if (msg && tone === 'ok') noticeTimer = setTimeout(hideNotice, 4000);
  }
  function hideNotice() { showNotice(''); }

  /* ───────── 화면 전환·이벤트 ───────── */

  function renderAll() {
    state.renderedDay = dateKey(new Date());
    $('#todayLabel').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    renderToday(); renderWeek(); renderMonth(); renderMeet(); renderTeam(); renderLinks();
    route();
  }

  function route() {
    const id = (location.hash || '#today').slice(1);
    state.view = document.getElementById(id)?.classList.contains('view') ? id : 'today';
    $$('.view').forEach(v => { v.hidden = v.id !== state.view; });
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === state.view));
  }

  function isBusy() {
    if ($$('dialog').some(d => d.open)) return true;
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
  }

  function tick() {
    const now = new Date();
    if (dateKey(now) !== state.renderedDay && !isBusy()) { renderAll(); return; }
    const c = $('#clock');
    if (c) c.textContent = clock(now);
    const pct = (minOf(now) + now.getSeconds() / 60) / 1440 * 100;
    $$('.now-line, .now-label').forEach(el => el.style.setProperty('--now', pct + '%'));
  }

  async function copyText(text, btn, label) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      (btn.closest('dialog') || document.body).appendChild(t);
      t.select(); document.execCommand('copy'); t.remove();
    }
    const old = label || btn.textContent;
    btn.textContent = '복사 완료';
    setTimeout(() => { btn.textContent = old; }, 1800);
  }

  // 이벤트는 처음 한 번만 연결해요 (화면을 다시 그려도 중복으로 붙지 않게)
  function bindEvents() {
    document.addEventListener('click', e => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      // 드롭다운 바깥을 누르면 닫혀요
      $$('.picker[open]').forEach(p => { if (!p.contains(t)) p.open = false; });

      const nav = t.closest('[data-cal]');
      if (nav) {
        const k = nav.dataset.cal === 'meet' ? 'meetMonth' : 'month';
        const step = +nav.dataset.step;
        state[k] = step === 0 ? monthStart(new Date()) : new Date(state[k].getFullYear(), state[k].getMonth() + step, 1);
        if (k === 'meetMonth') renderMeet(); else renderMonth();
        return;
      }
      const pickBtn = t.closest('[data-pick]');
      if (pickBtn) {
        const id = pickBtn.dataset.pick, mode = pickBtn.dataset.mode;
        $$(`[name="${id}Members"]`).forEach(b => {
          if (mode === 'all') b.checked = true;
          else if (mode === 'none') b.checked = false;
          else if (b.dataset.team === pickBtn.dataset.team) b.checked = true;
        });
        syncPicker(id);
        return;
      }
      const unpick = t.closest('[data-unpick]');
      if (unpick) {
        const id = unpick.dataset.unpick;
        $$(`[name="${id}Members"]`).forEach(b => { if (b.value === unpick.dataset.name) b.checked = false; });
        syncPicker(id);
        return;
      }
      const meeting = t.closest('[data-meeting]');
      if (meeting) { const m = state.data.meetings[+meeting.dataset.meeting]; if (m) openMeeting(m); return; }
      const fix = t.closest('[data-fix]');
      if (fix) { const x = state.meetResult?.[+fix.dataset.fix]; if (x && !fix.disabled) confirmMeeting(x, fix); return; }
      const dlgBtn = t.closest('[data-dlg]');
      if (dlgBtn && !dlgBtn.disabled) {
        const act = dlgBtn.dataset.dlg;
        if (act === 'close') $('#meetingDialog').close();
        else if (act === 'edit') { state.dlg.mode = 'edit'; renderMeetingDialog(); }
        else if (act === 'view') { state.dlg.mode = 'view'; renderMeetingDialog(); }
        else if (act === 'cancel') cancelMeeting();
        else if (act === 'discord') sendDiscord(dlgBtn);
        return;
      }
      if (t.closest('[data-more-cand]')) { state.showAllCand = true; renderCandidates(); return; }
      const closeBtn = t.closest('[data-dlg-close]');
      if (closeBtn) { $('#' + closeBtn.dataset.dlgClose).close(); return; }
      const copy = t.closest('[data-copy]');
      if (copy) { copyText($(copy.dataset.copy).value, copy); return; }
      const copyD = t.closest('[data-copy-diag]');
      if (copyD) { copyDiag(copyD); return; }
      if (t.closest('#syncStatus')) { renderDiag(); $('#diagDialog').showModal(); return; }
      if (t.closest('[data-pass-cancel]')) { closePass(null); return; }
      if (t.closest('[data-link-add]')) { state.linkFormOpen = true; renderLinks(); $('#linkTitle').focus(); return; }
      if (t.closest('[data-link-cancel]')) { state.linkFormOpen = false; state.linkDraft = null; renderLinks(); return; }
      const del = t.closest('[data-link-delete]');
      if (del) { deleteLink(del.dataset.linkDelete); return; }
      if (t.closest('#lockTeam')) { lockAdmin(); return; }
      if (t.closest('[data-reload]')) { load(); return; }
    });
    document.addEventListener('submit', e => {
      const id = e.target.id;
      if (!['meetForm', 'teamUnlock', 'linkForm', 'editForm', 'passForm'].includes(id)) return;
      e.preventDefault();
      if (id === 'meetForm') findCandidates();
      else if (id === 'teamUnlock') unlock();
      else if (id === 'linkForm') saveLink();
      else if (id === 'editForm') saveEdit();
      else closePass($('#passInput').value);
    });
    const saveDraft = e => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      const picker = t.closest('.picker');
      if (picker) syncPicker(picker.id.replace('Picker', ''));
      if (t.matches('[data-notify]')) { state.notifyDiscord = t.checked; $$('[data-notify]').forEach(x => { x.checked = t.checked; }); }
      if (t.closest('#meetForm')) state.meetDraft = readMeetForm();
      if (t.closest('#linkForm')) state.linkDraft = readLinkDraft();
    };
    document.addEventListener('input', saveDraft);
    document.addEventListener('change', saveDraft);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.picker[open]').forEach(p => { p.open = false; }); });
    $('#passDialog').addEventListener('close', () => { if (passResolve) closePass(null); });
    $('#refreshBtn').addEventListener('click', () => load());
    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (!state.lastSync || Date.now() - state.lastSync > 15000)) load({ quiet: true });
    });
  }

  bindEvents();
  renderAll();
  load();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !isBusy()) load({ quiet: true }); }, REFRESH_MS);
})();
