# AI 데이터 슬림

대용량 CSV/XLSX 파일을 브라우저 안에서 AI 학습용 TXT로 변환하는 웹앱입니다.
파일은 서버로 전송되지 않으며, GitHub Pages에서 무료로 운영할 수 있습니다.

## GitHub Pages 배포 방법

1. GitHub에서 `ai-data-slim`이라는 **Public 저장소**를 만듭니다.
2. 이 ZIP의 압축을 풀고 모든 파일을 저장소에 올립니다.
   - 가장 쉬운 방법은 GitHub Desktop에서 `Add an Existing Repository from your Hard Drive`를 선택하는 것입니다.
   - 저장소가 아니라는 안내가 나오면 `create a repository`를 누른 뒤 `Publish repository`를 선택합니다.
3. GitHub 저장소에서 `Settings → Pages`로 이동합니다.
4. `Build and deployment → Source`를 **GitHub Actions**로 선택합니다.
5. `Actions` 탭에서 `GitHub Pages 자동 배포` 작업이 완료될 때까지 기다립니다.
6. 배포 주소는 다음 형태입니다.

   `https://깃허브아이디.github.io/ai-data-slim/`

## 코드 수정 방법

- 화면과 기능: `src/App.tsx`
- 색상·폰트·레이아웃: `src/styles.css`
- 페이지 제목과 설명: `index.html`

파일을 수정해 `main` 브랜치에 저장하면 GitHub Actions가 자동으로 다시 배포합니다.

## 컴퓨터에서 미리보기

Node.js 22 이상이 설치되어 있다면 터미널에서 실행합니다.

```bash
npm install
npm run dev
```

브라우저에 표시되는 로컬 주소를 열면 됩니다.

## 기술 구성

- React + TypeScript + Vite
- PapaParse
- SheetJS/XLSX
- JSZip
- Lucide React

---

@miraehistory
