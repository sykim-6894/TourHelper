# 놀거리 도우미 (TourHelper)

지금 가면 좋은 곳(진행 중)과 곧 시작하는 행사를 테마·지역별로 보여 주는 정적 웹페이지입니다.

## 실행

```bash
npm run sample   # 키 없이 샘플 데이터 생성
npm run dev      # http://localhost:5173
```

## 실제 데이터 받기

1. `.env.example`을 `.env`로 복사 (프로젝트 루트에 둘 것)
2. 인증키 입력 — 둘 중 하나만 있어도 동작합니다
   - `TOUR_API_KEY`: [공공데이터포털](https://www.data.go.kr)에서 "한국관광공사 국문 관광정보 서비스" 활용 신청 → 축제·행사
   - 전시: 공공데이터포털에서 "한국문화정보원_한눈에보는문화정보조회서비스"도 활용 신청 (같은 `TOUR_API_KEY` 사용)
   - `KOPIS_API_KEY`: [공연예술통합전산망](https://www.kopis.or.kr) OPEN API 인증키 발급신청 → 공연
3. `npm run fetch` 실행 → `public/data/events.json` 갱신

공개 사이트(https://sykim-6894.github.io/TourHelper/)는 GitHub Actions(`.github/workflows/deploy.yml`)가 매일 06:00(한국 시간)에 수집해 배포합니다. 키는 저장소 Secrets에 있습니다. PC에서 직접 갱신하려면 `npm run fetch`를 실행합니다. 진행 중/예정 구분은 브라우저에서 오늘 날짜로 계산합니다.

## 직접 등록 (팝업, 핫한 행사 등)

`data/manual-events.json`에 추가하면 `npm run fetch` 때 함께 합쳐집니다.

```json
[
  {
    "title": "성수 팝업 스토어",
    "theme": "festival",
    "hot": true,
    "startDate": "2026-11-20",
    "endDate": "2026-11-30",
    "address": "서울특별시 성동구 연무장길 1",
    "lat": 37.5427,
    "lng": 127.0557,
    "link": "https://example.com"
  }
]
```

`theme`은 `festival`(축제·행사), `exhibition`(전시), `performance`(공연) 중 하나, `hot: true`면 "요즘 핫한"에 표시됩니다 (`hotLabel`로 배지 문구 지정 가능).

축제·전시는 `.env`에 `KAKAO_REST_API_KEY`([카카오 개발자센터](https://developers.kakao.com) REST API 키)가 있으면 다음 블로그 검색으로 최근 7일 글 수를 세어 자동 표시합니다. 기준값은 `scripts/fetch-events.mjs`의 `BUZZ`에서 조정합니다.

공연은 KOPIS 예매상황판의 최근 7일 예매 순위 50위 안에 들면 자동으로 "요즘 핫한"에 표시됩니다. 전주 순위권 밖에서 새로 들어온 공연은 "급상승"이 붙습니다.

## 구조

- `public/` — 배포 대상 (정적 호스팅에 이 폴더만 올리면 됨)
- `scripts/fetch-events.mjs` — 데이터 수집 (API 키는 여기서만 사용, 페이지에 노출되지 않음)
- `scripts/serve.mjs` — 개발용 서버
