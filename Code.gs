/**
 * METRO Team Board — 확정 회의 저장용 Apps Script 웹 앱
 * 사용 시트: "확정 회의" / 기준 시간대: Asia/Seoul
 * 스크립트 속성: ADMIN_PASS(필수), DISCORD_ENABLED·DISCORD_WEBHOOK_URL(선택)
 */
const SHEET_NAME = "확정 회의";
const TIME_ZONE = "Asia/Seoul";
const HEADERS = ["회의 ID","상태","회의명","시작 일시","종료 일시","참석자","관련 팀","회의 링크/장소","메모","디스코드 공지","생성 일시","수정 일시","공지 일시"];
const STATUSES = ["예정","확정","변경","취소","완료"];
const NOTICE_STATUSES = ["미공지","공지 완료","공지 실패","공지 제외"];
const MAX_LEN = 2000;
const MAX_FAILS = 20;

function doGet(e) {
  try { return out_({ok:true, meetings:readAll_(), timezone:TIME_ZONE}); }
  catch (err) { return out_({ok:false, error:msg_(err)}); }
}

function doPost(e) {
  let body;
  try { body = parseBody_(e); }
  catch (err) { return out_({ok:false, error:"요청 형식이 올바르지 않아요."}); }
  const auth = checkPass_(body.pass);
  if (!auth.ok) return out_(auth);
  if (body.action === "auth") return out_({ok:true});
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return out_({ok:false, error:"다른 저장이 진행 중이에요. 잠시 후 다시 시도해 주세요."});
  try {
    if (body.action === "create") create_(body.meeting || {});
    else if (body.action === "update") update_(String(body.id || ""), body.meeting || {});
    else if (body.action === "status") setStatus_(String(body.id || ""), String(body.status || ""));
    else if (body.action === "cancel") setStatus_(String(body.id || ""), "취소");
    else return out_({ok:false, error:"알 수 없는 요청이에요."});
    SpreadsheetApp.flush();
    return out_({ok:true, meetings:readAll_()});
  } catch (err) { return out_({ok:false, error:msg_(err)}); }
  finally { lock.releaseLock(); }
}

// 편집기에서 최초 1회 실행해 시트·서식을 점검하세요.
function setup() {
  const sh = sheet_();
  formatSheet_(sh);
  Logger.log("'" + SHEET_NAME + "' 준비 완료 / ADMIN_PASS: " + (PropertiesService.getScriptProperties().getProperty("ADMIN_PASS") ? "설정됨" : "미설정"));
}

function parseBody_(e) {
  const raw = (e && e.postData && e.postData.contents) || "";
  if (raw) { try { return JSON.parse(raw); } catch (ignore) {} }
  const p = (e && e.parameter) || {};
  if (p.meeting && typeof p.meeting === "string") { try { p.meeting = JSON.parse(p.meeting); } catch (ignore) {} }
  return p;
}

function checkPass_(pass) {
  const want = PropertiesService.getScriptProperties().getProperty("ADMIN_PASS");
  if (!want) return {ok:false, error:"Apps Script의 스크립트 속성에 ADMIN_PASS를 먼저 추가해 주세요."};
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("fails") || 0);
  if (fails >= MAX_FAILS) return {ok:false, error:"비밀번호를 여러 번 틀려서 10분 동안 잠겼어요."};
  if (String(pass || "") !== want) {
    cache.put("fails", String(fails + 1), 600);
    return {ok:false, error:"관리 비밀번호가 맞지 않아요."};
  }
  cache.remove("fails");
  return {ok:true};
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  columns_(sh);
  return sh;
}

// 열을 옮겨도 헤더 이름으로 찾아 동작합니다.
function columns_(sh) {
  if (sh.getLastRow() === 0) sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]);
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1,1,1,lastCol).getDisplayValues()[0].map(function(x){return String(x).trim();});
  const map = {};
  head.forEach(function(name,i){if(name && !(name in map)) map[name]=i;});
  let width = head.length;
  HEADERS.forEach(function(name){if(!(name in map)){sh.getRange(1,width+1).setValue(name);map[name]=width++;}});
  return {map:map,width:width};
}

function formatSheet_(sh) {
  const c = columns_(sh);
  sh.setFrozenRows(1);
  sh.getRange(1,1,1,c.width).setFontWeight("bold").setBackground("#755447").setFontColor("#ffffff").setHorizontalAlignment("center");
  if (sh.getMaxRows() > 1) {
    sh.getRange(2,c.map["시작 일시"]+1,sh.getMaxRows()-1,2).setNumberFormat("yyyy-mm-dd hh:mm");
    sh.getRange(2,c.map["생성 일시"]+1,sh.getMaxRows()-1,3).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    sh.getRange(2,c.map["상태"]+1,sh.getMaxRows()-1,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES,true).setAllowInvalid(false).build());
    sh.getRange(2,c.map["디스코드 공지"]+1,sh.getMaxRows()-1,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(NOTICE_STATUSES,true).setAllowInvalid(false).build());
  }
}

function readAll_() {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  const c = columns_(sh), range = sh.getRange(2,1,sh.getLastRow()-1,c.width);
  const raw = range.getValues(), display = range.getDisplayValues(), list = [];
  raw.forEach(function(row,r){
    if(!row.some(function(v){return String(v).trim();})) return;
    const o = {};
    HEADERS.forEach(function(h){const i=c.map[h];o[h]=row[i] instanceof Date?Utilities.formatDate(row[i],TIME_ZONE,dateFormat_(h)):String(display[r][i]||"");});
    // 이전 홈페이지 코드와의 호환 필드
    const start=asDate_(row[c.map["시작 일시"]]), end=asDate_(row[c.map["종료 일시"]]);
    o["대상 팀"]=o["관련 팀"];
    o["날짜"]=start?Utilities.formatDate(start,TIME_ZONE,"yyyy-MM-dd"):"";
    o["시작 시간"]=start?Utilities.formatDate(start,TIME_ZONE,"HH:mm"):"";
    o["종료 시간"]=end?((start&&Utilities.formatDate(end,TIME_ZONE,"yyyy-MM-dd")!==o["날짜"]?"익일 ":"")+Utilities.formatDate(end,TIME_ZONE,"HH:mm")):"";
    o["확정 시각"]=o["생성 일시"];
    o["참석 가능 인원"]=o["참석자"];
    o["추가 확인 필요 인원"]="";
    list.push(o);
  });
  list.sort(function(a,b){return String(a["시작 일시"]).localeCompare(String(b["시작 일시"]));});
  return list;
}

function create_(m) {
  const v=normalizeMeeting_(m,true), sh=sheet_(), c=columns_(sh);
  let id=clean_(m["회의 ID"]);
  const ids=sh.getLastRow()>=2?sh.getRange(2,c.map["회의 ID"]+1,sh.getLastRow()-1,1).getDisplayValues().map(function(r){return r[0];}):[];
  if(!id||ids.indexOf(id)>=0) id="M"+Utilities.getUuid().replace(/-/g,"").slice(0,10).toUpperCase();
  const now=new Date();
  v["회의 ID"]=id;v["생성 일시"]=now;v["수정 일시"]=now;v["공지 일시"]="";
  writeRow_(sh,c,sh.getLastRow()+1,v);
  maybeNotifyDiscord_(sh,sh.getLastRow(),v);
}

function update_(id,m) {
  if(!id) throw new Error("회의 ID가 없어요.");
  const sh=sheet_(),c=columns_(sh),rowNo=findRow_(sh,c,id),current=rowObject_(sh,c,rowNo),merged={};
  HEADERS.forEach(function(h){merged[h]=current[h];});
  Object.keys(m||{}).forEach(function(k){merged[k]=m[k];});
  const v=normalizeMeeting_(merged,false);
  v["회의 ID"]=id;v["생성 일시"]=current["생성 일시"]||new Date();v["수정 일시"]=new Date();v["공지 일시"]=current["공지 일시"]||"";
  writeRow_(sh,c,rowNo,v);maybeNotifyDiscord_(sh,rowNo,v);
}

function setStatus_(id,status) {
  if(!id) throw new Error("회의 ID가 없어요.");
  if(STATUSES.indexOf(status)<0) throw new Error("상태는 예정·확정·변경·취소·완료 중 하나여야 해요.");
  const sh=sheet_(),c=columns_(sh),rowNo=findRow_(sh,c,id);
  sh.getRange(rowNo,c.map["상태"]+1).setValue(status);
  sh.getRange(rowNo,c.map["수정 일시"]+1).setValue(new Date()).setNumberFormat("yyyy-mm-dd hh:mm:ss");
}

function normalizeMeeting_(m,isNew) {
  const title=clean_(m["회의명"]);
  if(!title) throw new Error("회의명이 비어 있어요.");
  let start=parseAnyDate_(m["시작 일시"]),end=parseAnyDate_(m["종료 일시"]);
  const date=clean_(m["날짜"]);
  if(!start&&date) start=parseKoreaDateTime_(date,clean_(m["시작 시간"]));
  if(!end&&date) end=parseKoreaDateTime_(date,clean_(m["종료 시간"]));
  if(!start||!end) throw new Error("회의 날짜와 시작·종료 시간을 확인해 주세요.");
  if(end<=start) end=new Date(end.getTime()+86400000);
  const extra=clean_(m["추가 확인 필요 인원"]);
  let memo=clean_(m["메모"]);
  if(extra&&memo.indexOf(extra)<0) memo+=(memo?"\n":"")+"추가 확인 필요: "+extra;
  const status=clean_(m["상태"]),notice=clean_(m["디스코드 공지"]);
  return {
    "상태":STATUSES.indexOf(status)>=0?status:(isNew?"확정":"예정"),"회의명":title,"시작 일시":start,"종료 일시":end,
    "참석자":clean_(m["참석자"]||m["참석 가능 인원"]),"관련 팀":clean_(m["관련 팀"]||m["대상 팀"])||"전체",
    "회의 링크/장소":clean_(m["회의 링크/장소"]),"메모":memo,"디스코드 공지":NOTICE_STATUSES.indexOf(notice)>=0?notice:"미공지"
  };
}

function writeRow_(sh,c,rowNo,v) {
  const row=new Array(c.width).fill("");
  HEADERS.forEach(function(h){if(h in v) row[c.map[h]]=valueForSheet_(v[h]);});
  sh.getRange(rowNo,1,1,c.width).setValues([row]);
  sh.getRange(rowNo,c.map["시작 일시"]+1,1,2).setNumberFormat("yyyy-mm-dd hh:mm");
  sh.getRange(rowNo,c.map["생성 일시"]+1,1,3).setNumberFormat("yyyy-mm-dd hh:mm:ss");
}

function rowObject_(sh,c,rowNo){const row=sh.getRange(rowNo,1,1,c.width).getValues()[0],o={};HEADERS.forEach(function(h){o[h]=row[c.map[h]];});return o;}
function findRow_(sh,c,id){if(sh.getLastRow()<2)throw new Error("저장된 회의가 없어요.");const ids=sh.getRange(2,c.map["회의 ID"]+1,sh.getLastRow()-1,1).getDisplayValues();for(let i=0;i<ids.length;i++)if(ids[i][0]===id)return i+2;throw new Error("그 회의를 시트에서 찾지 못했어요.");}
function parseAnyDate_(v){if(v instanceof Date&&!isNaN(v.getTime()))return v;const s=clean_(v);if(!s)return null;const m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/);if(m)return koreaDate_(+m[1],+m[2],+m[3],+m[4],+m[5]);const d=new Date(s);return isNaN(d.getTime())?null:d;}
function parseKoreaDateTime_(d,t){const dm=String(d).match(/^(\d{4})-(\d{2})-(\d{2})$/),tm=String(t).match(/^(익일\s*)?(\d{1,2}):(\d{2})$/);return(!dm||!tm)?null:koreaDate_(+dm[1],+dm[2],+dm[3],+tm[2]+(tm[1]?24:0),+tm[3]);}
function koreaDate_(y,m,d,h,min){return new Date(Date.UTC(y,m-1,d,h-9,min,0));}
function asDate_(v){return v instanceof Date&&!isNaN(v.getTime())?v:parseAnyDate_(v);}
function dateFormat_(h){return h==="시작 일시"||h==="종료 일시"?"yyyy-MM-dd HH:mm":"yyyy-MM-dd HH:mm:ss";}
function valueForSheet_(v){return v instanceof Date?v:safe_(clean_(v));}

// 기본은 꺼짐. DISCORD_ENABLED=true와 웹후크를 설정하면 자동 공지됩니다.
function maybeNotifyDiscord_(sh,rowNo,m) {
  const p=PropertiesService.getScriptProperties();
  if(String(p.getProperty("DISCORD_ENABLED")||"").toLowerCase()!=="true"||m["디스코드 공지"]==="공지 제외")return;
  const url=p.getProperty("DISCORD_WEBHOOK_URL");if(!url)return;
  const c=columns_(sh);
  try {
    const text="📅 **"+m["회의명"]+"**\n"+Utilities.formatDate(m["시작 일시"],TIME_ZONE,"yyyy-MM-dd HH:mm")+" ~ "+Utilities.formatDate(m["종료 일시"],TIME_ZONE,"HH:mm")+(m["관련 팀"]?"\n대상: "+m["관련 팀"]:"")+(m["회의 링크/장소"]?"\n장소/링크: "+m["회의 링크/장소"]:"");
    const res=UrlFetchApp.fetch(url,{method:"post",contentType:"application/json",payload:JSON.stringify({content:text}),muteHttpExceptions:true});
    if(res.getResponseCode()<200||res.getResponseCode()>=300)throw new Error("Discord HTTP "+res.getResponseCode());
    sh.getRange(rowNo,c.map["디스코드 공지"]+1).setValue("공지 완료");sh.getRange(rowNo,c.map["공지 일시"]+1).setValue(new Date()).setNumberFormat("yyyy-mm-dd hh:mm:ss");
  } catch(err) { sh.getRange(rowNo,c.map["디스코드 공지"]+1).setValue("공지 실패"); }
}

function clean_(v){return String(v==null?"":v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").trim().slice(0,MAX_LEN);}
function safe_(v){const s=String(v);return/^[=+\-@]/.test(s)?"'"+s:s;}
function msg_(err){return String((err&&err.message)||err||"알 수 없는 오류");}
function out_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
