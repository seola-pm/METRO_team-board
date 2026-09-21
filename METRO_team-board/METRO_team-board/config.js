/* ================================================================
   METRO Team Board 설정
   시트 주소·폼 주소·헤더 이름은 모두 이 파일 한 곳에만 적어요.
   ================================================================ */
window.METRO_CONFIG = {
  title: "METRO Team Board",
  timeZone: "Asia/Seoul",

  // 관리자 시트 [파일 > 공유 > 웹에 게시]에서 탭을 하나씩 고르고 'CSV'로 게시한 주소
  sheets: {
    roster:   "https://docs.google.com/spreadsheets/d/e/2PACX-1vQWQhqZmCPXO3k5ZxXY7LbPitI9K2_dtsDpWu9iMh6YJjqSBzY0Fz9t3-sWSL9Ek1kKwSrtiCf-CY41/pub?gid=866033058&single=true&output=csv",  // 명단
    weekly:   "https://docs.google.com/spreadsheets/d/e/2PACX-1vQWQhqZmCPXO3k5ZxXY7LbPitI9K2_dtsDpWu9iMh6YJjqSBzY0Fz9t3-sWSL9Ek1kKwSrtiCf-CY41/pub?gid=811467492&single=true&output=csv",  // 근무시간 응답
    leave:    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQWQhqZmCPXO3k5ZxXY7LbPitI9K2_dtsDpWu9iMh6YJjqSBzY0Fz9t3-sWSL9Ek1kKwSrtiCf-CY41/pub?gid=1873325900&single=true&output=csv", // 휴가일정 응답
    departed: "",  // 빠진 멤버 (게시 후 주소를 넣어주세요)
    meetings: "",  // 회의 확정 (Apps Script를 안 쓸 때 읽기 전용으로)
  },

  // 회의 확정을 시트에 저장하는 Apps Script 웹 앱 주소 (apps-script/Code.gs 참고)
  // 비워두면 확정한 회의가 이 기기 브라우저에만 저장돼요.
  meetingApi: "",

  // 팀원이 쓰는 구글 폼
  forms: {
    weekly: "https://docs.google.com/forms/d/e/1FAIpQLScIoOoNupD-pgA72hhXg-Lz4nRpBj6dly33ygFfoBDneQ0v7g/viewform",
    leave:  "https://docs.google.com/forms/d/e/1FAIpQLSe6T11sDoQKH7q5KqlhPFRLSgvoEIrhNppqYDP3GI3XBCIr4g/viewform",
  },

  // 몇 분마다 시트를 다시 불러올지
  refreshMinutes: 3,

  // 회의 화면 기본값
  meetingDefaults: { title: "정기회의", minutes: 60, fromHour: 10, toHour: 24, period: "2w" },

  // 시트의 헤더(첫 줄) 이름. 정확히 같은 이름을 먼저 찾고, 없으면 이 낱말이 들어간 칸을 찾아요.
  headers: {
    name: ["이름"],
    team: ["팀"],
    activity: ["활동 상태"],
    checkMode: ["일정 확인 방식"],
    offStart: ["OFF 시작일"],
    offEnd: ["예상 복귀일"],
    memo: ["메모"],
    timestamp: ["타임스탬프"],
    kind: ["종류"],
    start: ["시작일", "시작"],
    end: ["종료일", "종료", "끝"],
    time: ["시간"],
    content: ["내용"],
    leftAt: ["나간 날짜", "종료일", "날짜"],
  },

  // 시트에 적는 값 (이 낱말이 들어 있으면 그 상태로 봐요)
  values: {
    longOff: ["장기 OFF", "장기"],
    limited: ["제한적 활동", "제한"],
    checkEach: ["일정별 확인 필요", "일정별"],
  },

  // (선택) 팀 색상을 직접 정할 때: { "아트팀": "#B45C77" }
  teamColors: {},
};
