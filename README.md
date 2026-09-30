# METRO Team Board

현재 운영 중인 팀보드를 중복 파일 없이 정리한 배포용 파일입니다.

## 구성
- index.html: 화면, 스타일, JavaScript, 연결 설정이 포함된 통합 파일
- README.md: 설치 및 수정 안내

## GitHub 업로드
1. 기존 저장소를 ZIP으로 다운로드하여 백업해 둡니다.
2. 기존 중복 사이트 파일과 폴더를 제거합니다. 저장소 자체나 Pages 설정은 삭제하지 않습니다.
3. 이 ZIP을 압축 해제합니다.
4. index.html과 README.md 두 파일을 저장소 최상위에 업로드합니다. 압축 파일이나 압축을 푼 상위 폴더를 업로드하지 않습니다.
5. GitHub Pages는 main 브랜치의 / (root) 설정을 유지합니다.
6. 배포 완료 후 오늘, 이번 주, 이번 달, 회의, 팀 명단, 링크 허브와 시트 연결 상태를 확인합니다.

## Google Apps Script
GitHub의 .gs 파일은 실행 서버가 아니라 코드 보관본입니다. 이 정리본에는 서로 다른 구버전 .gs 보관본을 포함하지 않았습니다.
현재 Google Apps Script에 저장되고 배포된 코드는 유지합니다. Apps Script 프로젝트나 배포를 삭제하지 않습니다.
기존 기본 연결과 관리자 연결 주소는 index.html 안에 유지되어 있습니다.
사용자가 앞서 제공한 관리자 Apps Script 원문과 기존 저장소 ZIP을 별도 백업으로 보관합니다.

## 수정
연결 설정은 index.html 상단의 window.METRO_CONFIG에 있습니다.
별도 config.js, app.js, styles.css, fixes.css, css/, js/ 폴더는 필요하지 않습니다.
회의 및 링크 저장 기능은 기존 Apps Script 배포에 의존합니다.

## 이번 정리의 범위
기존 최상위 index.html의 바이트를 그대로 보존했습니다.
에픽 작업 조회, 오늘 할 일, 개인 체크리스트 기능은 아직 추가하지 않았습니다.
실제 GitHub 및 Google Sheets 원본은 이번 파일 제작으로 변경되지 않았습니다.
