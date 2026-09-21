window.METRO_CONFIG = {
  // 기본 연결: 명단·근무시간을 보내주는 기존 Apps Script 웹 앱 주소 (/exec로 끝나요)
  API_URL: "https://script.google.com/macros/s/AKfycbwywkuWFYE4OBATUIvvlRwhrZIp6_T-QRcQhgCbdvB3i_wkRoLRYXdThMtMu9D7W8S0/exec",
  // 관리용 연결: metro-admin.gs를 새 프로젝트로 배포한 뒤 나오는 웹 앱 주소를 따옴표 안에 붙여 넣으세요.
  // 비어 있으면 휴가 일정은 시트에서 직접 읽고, 회의 수정·취소는 쓸 수 없어요.
  ADMIN_API_URL: "https://script.google.com/macros/s/AKfycby8BriZJcZ90paFSkb7iMza6OZg_25iW-leHsPv4jLrKtmxOfgJZgq6H2r89oLwIaWx/exec",
  // 관리자 시트는 링크 허브에서 관리자에게만 보여요.
  SHEET_URL: "https://docs.google.com/spreadsheets/d/1Ga7YPgjz1HQy1-el6oi8QxruGht3VpaEWPY5ig3Ukq4/edit",
  WORK_FORM_URL: "https://docs.google.com/forms/d/e/1FAIpQLScIoOoNupD-pgA72hhXg-Lz4nRpBj6dly33ygFfoBDneQ0v7g/viewform",
  LEAVE_FORM_URL: "https://docs.google.com/forms/d/e/1FAIpQLSe6T11sDoQKH7q5KqlhPFRLSgvoEIrhNppqYDP3GI3XBCIr4g/viewform",
  SLOT_MINUTES: 30
};
