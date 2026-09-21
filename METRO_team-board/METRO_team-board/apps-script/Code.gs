/**
 * METRO Team Board — 회의 확정 저장용 Apps Script 웹 앱
 *
 * · 관리자 시트의 '회의 확정' 탭만 읽고 씁니다. 폼 응답 탭(근무시간 응답·휴가일정 응답)은 절대 건드리지 않아요.
 * · 탭이 없으면 처음 저장할 때 헤더와 함께 자동으로 만들어요.
 * · 저장·상태 변경에는 관리 비밀번호가 필요해요. 비밀번호는 코드에 적지 않고
 *   [프로젝트 설정 > 스크립트 속성]에 ADMIN_PASS 라는 이름으로 넣어요.
 *
 * 설치 방법은 README.md의 'Apps Script 연결'을 보세요.
 */

const SHEET_NAME = "회의 확정";
const HEADERS = ["회의 ID", "회의명", "대상 팀", "날짜", "시작 시간", "종료 시간", "확정 시각", "참석 가능 인원", "추가 확인 필요 인원", "메모", "상태"];
const STATUSES = ["예정", "완료", "취소"];
const MAX_LEN = 1000;
const MAX_FAILS = 20; // 10분 동안 비밀번호를 이만큼 틀리면 잠깐 막아요

// ---------------- 웹 앱 입구 ----------------
function doGet(e) {
  try {
    return out_({ ok: true, meetings: readAll_() });
  } catch (err) {
    return out_({ ok: false, error: msg_(err) });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return out_({ ok: false, error: "요청 형식이 올바르지 않아요." });
  }

  const auth = checkPass_(body.pass);
  if (!auth.ok) return out_(auth);
  if (body.action === "auth") return out_({ ok: true });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return out_({ ok: false, error: "다른 저장이 진행 중이에요. 잠시 후 다시 시도해 주세요." });
  try {
    if (body.action === "create") create_(body.meeting || {});
    else if (body.action === "status") setStatus_(String(body.id || ""), String(body.status || ""));
    else return out_({ ok: false, error: "알 수 없는 요청이에요." });
    return out_({ ok: true, meetings: readAll_() });
  } catch (err) {
    return out_({ ok: false, error: msg_(err) });
  } finally {
    lock.releaseLock();
  }
}

// 편집기에서 한 번 실행하면 '회의 확정' 탭을 미리 만들어요 (선택)
function setup() {
  sheet_();
  const has = !!PropertiesService.getScriptProperties().getProperty("ADMIN_PASS");
  Logger.log("'" + SHEET_NAME + "' 탭 준비 완료. 관리 비밀번호(ADMIN_PASS): " + (has ? "설정됨" : "아직 없음 — 프로젝트 설정 > 스크립트 속성에서 추가하세요"));
}

// ---------------- 비밀번호 ----------------
function checkPass_(pass) {
  const want = PropertiesService.getScriptProperties().getProperty("ADMIN_PASS");
  if (!want) return { ok: false, error: "Apps Script에 관리 비밀번호(ADMIN_PASS)가 아직 없어요. 프로젝트 설정 > 스크립트 속성에서 추가해 주세요." };
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("fails") || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: "비밀번호를 여러 번 틀려서 10분 동안 잠겼어요." };
  if (String(pass || "") !== want) {
    cache.put("fails", String(fails + 1), 600);
    return { ok: false, error: "관리 비밀번호가 맞지 않아요." };
  }
  return { ok: true };
}

// ---------------- 시트 ----------------
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

// 헤더 이름으로 열 위치 찾기. 누가 열을 옮겨도 동작하고, 없는 헤더는 끝에 붙여요.
function columns_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(function (x) { return String(x).trim(); });
  const map = {};
  head.forEach(function (name, i) { if (name && !(name in map)) map[name] = i; });
  let width = head.length;
  HEADERS.forEach(function (name) {
    if (!(name in map)) {
      sh.getRange(1, width + 1).setValue(name).setFontWeight("bold");
      map[name] = width;
      width += 1;
    }
  });
  return { map: map, width: width };
}

function readAll_() {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getDisplayValues();
  const head = values[0].map(function (x) { return String(x).trim(); });
  const list = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row.some(function (c) { return String(c).trim(); })) continue;
    const o = {};
    head.forEach(function (name, i) { if (name && !(name in o)) o[name] = String(row[i]); });
    list.push(o);
  }
  return list;
}

function create_(m) {
  const title = clean_(m["회의명"]);
  const date = clean_(m["날짜"]);
  const start = clean_(m["시작 시간"]);
  const end = clean_(m["종료 시간"]);
  if (!title) throw new Error("회의명이 비어 있어요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("날짜 형식이 올바르지 않아요.");
  if (!/^(익일 )?\d{2}:\d{2}$/.test(start) || !/^(익일 )?\d{2}:\d{2}$/.test(end)) throw new Error("시간 형식이 올바르지 않아요.");

  const sh = sheet_();
  const cols = columns_(sh);
  let id = clean_(m["회의 ID"]);
  const ids = sh.getLastRow() >= 2 ? sh.getRange(2, cols.map["회의 ID"] + 1, sh.getLastRow() - 1, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
  if (!id || ids.indexOf(id) >= 0) id = "M" + Utilities.getUuid().slice(0, 8);

  const status = STATUSES.indexOf(clean_(m["상태"])) >= 0 ? clean_(m["상태"]) : "예정";
  const values = {
    "회의 ID": id, "회의명": title, "대상 팀": clean_(m["대상 팀"]) || "전체",
    "날짜": date, "시작 시간": start, "종료 시간": end,
    "확정 시각": clean_(m["확정 시각"]) || Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm"),
    "참석 가능 인원": clean_(m["참석 가능 인원"]), "추가 확인 필요 인원": clean_(m["추가 확인 필요 인원"]),
    "메모": clean_(m["메모"]), "상태": status,
  };
  const row = new Array(cols.width).fill("");
  Object.keys(values).forEach(function (k) { row[cols.map[k]] = safe_(values[k]); });
  // 글자 형식(@)으로 저장해서 시트가 날짜·시간을 멋대로 바꾸지 않게 해요
  sh.getRange(sh.getLastRow() + 1, 1, 1, cols.width).setNumberFormat("@").setValues([row]);
}

function setStatus_(id, status) {
  if (!id) throw new Error("회의 ID가 없어요.");
  if (STATUSES.indexOf(status) < 0) throw new Error("상태는 예정·완료·취소 중 하나여야 해요.");
  const sh = sheet_();
  const cols = columns_(sh);
  if (sh.getLastRow() < 2) throw new Error("저장된 회의가 없어요.");
  const ids = sh.getRange(2, cols.map["회의 ID"] + 1, sh.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) {
      sh.getRange(i + 2, cols.map["상태"] + 1).setNumberFormat("@").setValue(status);
      return;
    }
  }
  throw new Error("그 회의를 시트에서 찾지 못했어요. 시트에서 지워졌을 수 있어요.");
}

// ---------------- 도우미 ----------------
function clean_(v) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, MAX_LEN);
}
// =, +, -, @ 로 시작하는 글자가 수식으로 실행되지 않게 앞에 ' 를 붙여요
function safe_(v) {
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function msg_(err) { return String((err && err.message) || err || "알 수 없는 오류"); }
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
