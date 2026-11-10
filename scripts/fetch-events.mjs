// 행사 데이터를 모아 public/data/events.json 으로 저장한다.
//   node scripts/fetch-events.mjs            실제 데이터 (TOUR_API_KEY 필요)
//   node scripts/fetch-events.mjs --sample   화면 확인용 샘플 데이터
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/events.json');
const MANUAL = resolve(ROOT, 'data/manual-events.json');

// 진행 중인 행사를 놓치지 않도록 과거 시작분까지 조회한 뒤, 아래 기간으로 걸러낸다.
const LOOKBACK_DAYS = 180;
const LOOKAHEAD_DAYS = 60;

const TOUR_ENDPOINT =
  process.env.TOUR_API_ENDPOINT ||
  'https://apis.data.go.kr/B551011/KorService2/searchFestival2';

// ---------- 요청 ----------
// 일시적인 네트워크 오류와 서버 오류(5xx, 429)는 잠시 뒤 다시 시도한다.
// 오류 메시지에는 주소의 호스트만 넣는다 (쿼리에 인증키가 들어 있다).
async function fetchRetry(url, options, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, options);
      if (attempt < tries && (res.status >= 500 || res.status === 429)) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt >= tries) throw new Error(`${new URL(url).host} 요청 실패: ${err.cause?.code ?? err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

// ---------- 날짜 ----------
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// '20261110' -> '2026-11-10'
function toIso(compact) {
  const s = String(compact ?? '').trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

// ---------- 정규화 ----------
const REGION_PREFIXES = [
  ['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'],
  ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'],
  ['경기', '경기'], ['강원', '강원'],
  ['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'],
  ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'],
  ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'],
  ['제주', '제주'],
];

function regionOf(address) {
  const a = String(address ?? '').trim();
  const hit = REGION_PREFIXES.find(([prefix]) => a.startsWith(prefix));
  return hit ? hit[1] : '기타';
}

// 테마: festival(축제·행사) / exhibition(전시) / performance(공연)
const THEMES = new Set(['festival', 'exhibition', 'performance']);
const EXHIBITION_WORDS = /전시|비엔날레|아트페어/;
const PERFORMANCE_WORDS = /공연|콘서트|뮤지컬|연극|오페라|음악회|리사이틀/;

function themeOf(item) {
  const title = item.title ?? '';
  if (EXHIBITION_WORDS.test(title)) return 'exhibition';
  if (PERFORMANCE_WORDS.test(title)) return 'performance';
  return 'festival';
}

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

const httpsUrl = (v) => {
  const s = String(v ?? '').trim().replace(/^http:\/\//, 'https://');
  return s.startsWith('https://') ? s : null;
};

function fromTourItem(item) {
  const startDate = toIso(item.eventstartdate);
  const endDate = toIso(item.eventenddate);
  const title = String(item.title ?? '').trim();
  if (!startDate || !endDate || !title) return null;
  const address = [item.addr1, item.addr2].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  return {
    id: `tour-${item.contentid}`,
    title,
    theme: themeOf(item),
    hot: false,
    startDate,
    endDate,
    region: regionOf(address),
    address,
    lat: num(item.mapy),
    lng: num(item.mapx),
    image: httpsUrl(item.firstimage) ?? httpsUrl(item.firstimage2),
    tel: String(item.tel ?? '').trim() || null,
    link: null,
    source: 'tourapi',
  };
}

// ---------- TourAPI ----------
async function fetchTourApi(rawKey, today) {
  // 공공데이터포털의 인코딩 키(% 포함)를 넣어도 동작하도록 한 번 풀어 준다.
  const key = rawKey.includes('%') ? decodeURIComponent(rawKey) : rawKey;
  const from = addDays(today, -LOOKBACK_DAYS).replaceAll('-', '');
  const items = [];

  for (let pageNo = 1; pageNo <= 50; pageNo++) {
    const params = new URLSearchParams({
      serviceKey: key,
      MobileOS: 'ETC',
      MobileApp: 'TourHelper',
      _type: 'json',
      numOfRows: '200',
      pageNo: String(pageNo),
      eventStartDate: from,
    });
    const res = await fetchRetry(`${TOUR_ENDPOINT}?${params}`);
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // 키 오류 등은 _type=json 이어도 XML/텍스트로 내려온다.
      throw new Error(`TourAPI 응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    const header = json.response?.header ?? json;
    if (header.resultCode && header.resultCode !== '0000') {
      throw new Error(`TourAPI 오류 ${header.resultCode}: ${header.resultMsg ?? ''}`);
    }

    const body = json.response?.body;
    if (!body) throw new Error(`TourAPI 응답 형식이 예상과 다릅니다: ${text.slice(0, 300)}`);

    const page = body.items?.item ?? [];
    items.push(...(Array.isArray(page) ? page : [page]));

    const total = Number(body.totalCount ?? 0);
    if (page.length === 0 || items.length >= total) break;
  }
  return items.map(fromTourItem).filter(Boolean);
}

// ---------- KOPIS (공연예술통합전산망) ----------
const KOPIS_ENDPOINT = 'https://www.kopis.or.kr/openApi/restful/pblprfr';
const KOPIS_DETAIL = 'https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?menuId=MNU_00020&mt20Id=';
const KOPIS_WINDOW_DAYS = 31; // 한 번에 조회할 수 있는 최대 기간
const KOPIS_ROWS = 100; // 한 번에 조회할 수 있는 최대 건수

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlText(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return m[1]
    .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, name) => {
      if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()];
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    })
    .trim();
}

// '2026.11.10' -> '2026-11-10'
const dotDateToIso = (s) => (/^\d{4}\.\d{2}\.\d{2}$/.test(s) ? s.replaceAll('.', '-') : null);

export function parseKopisXml(xml) {
  const blocks = xml.match(/<db>[\s\S]*?<\/db>/g) ?? [];
  const code = xmlText(blocks[0] ?? '', 'returncode');
  if (code === '04') return []; // NODATA
  if (code && code !== '00') throw new Error(`KOPIS 오류 ${code}: ${xmlText(blocks[0], 'errmsg')}`);

  return blocks.flatMap((block) => {
    const id = xmlText(block, 'mt20id');
    const title = xmlText(block, 'prfnm');
    const startDate = dotDateToIso(xmlText(block, 'prfpdfrom'));
    const endDate = dotDateToIso(xmlText(block, 'prfpdto'));
    if (!id || !title || !startDate || !endDate) return [];
    return [{
      id: `kopis-${id}`,
      title,
      theme: 'performance',
      genre: xmlText(block, 'genrenm') || null,
      hot: false,
      startDate,
      endDate,
      region: regionOf(xmlText(block, 'area')),
      address: xmlText(block, 'fcltynm'), // 목록 API 는 공연장 이름만 제공한다 (좌표 없음)
      lat: null,
      lng: null,
      image: httpsUrl(xmlText(block, 'poster')),
      tel: null,
      link: KOPIS_DETAIL + encodeURIComponent(id),
      source: 'kopis',
    }];
  });
}

// KOPIS 는 짧은 시간에 요청이 몰리면 HTTP 400 "Request Blocked" 로 한동안 막는다 (공식 한도는 미공개).
// 요청 사이를 띄우고, 막히면 1분 남짓 쉬었다가 간격을 더 벌려 다시 시도한다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kopisPace = { gap: 1000, last: 0 };

async function kopisGet(url) {
  for (let attempt = 1; ; attempt++) {
    const wait = kopisPace.last + kopisPace.gap - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetchRetry(url);
    kopisPace.last = Date.now();
    const xml = await res.text();
    if (res.status !== 400 || !xml.includes('Request Blocked')) return { res, xml };

    if (attempt >= 4) throw new Error('KOPIS 가 요청을 계속 차단합니다 (호출 빈도 제한)');
    console.warn('KOPIS 호출 빈도 제한에 걸렸습니다. 65초 쉬고 요청 간격을 7초로 늘립니다.');
    kopisPace.gap = 7000;
    await sleep(65000);
  }
}

async function fetchKopis(key, today) {
  const events = [];
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += KOPIS_WINDOW_DAYS) {
    const stdate = addDays(today, offset).replaceAll('-', '');
    const eddate = addDays(today, Math.min(offset + KOPIS_WINDOW_DAYS - 1, LOOKAHEAD_DAYS)).replaceAll('-', '');

    for (let cpage = 1; cpage <= 300; cpage++) {
      const params = new URLSearchParams({ service: key, stdate, eddate, cpage: String(cpage), rows: String(KOPIS_ROWS) });
      const { res, xml } = await kopisGet(`${KOPIS_ENDPOINT}?${params}`);
      if (!res.ok) throw new Error(`KOPIS 응답 오류 (HTTP ${res.status}): ${xml.slice(0, 300)}`);

      const page = parseKopisXml(xml);
      events.push(...page.filter((e) => e.region !== '기타')); // 해외 공연 제외
      if (page.length < KOPIS_ROWS) break;
    }
  }
  return events;
}

// 예매상황판: 기간 내 예매 순위 상위 50개 공연의 { 공연ID -> 순위 }
const KOPIS_BOXOFFICE = 'https://www.kopis.or.kr/openApi/restful/boxoffice';

async function fetchBoxofficeRanks(key, stdate, eddate) {
  const params = new URLSearchParams({
    service: key,
    stdate: stdate.replaceAll('-', ''),
    eddate: eddate.replaceAll('-', ''),
  });
  const { res, xml } = await kopisGet(`${KOPIS_BOXOFFICE}?${params}`);
  if (!res.ok) throw new Error(`KOPIS 예매상황판 응답 오류 (HTTP ${res.status})`);

  const code = xmlText(xml, 'returncode');
  if (code && code !== '00' && code !== '04') throw new Error(`KOPIS 예매상황판 오류 ${code}: ${xmlText(xml, 'errmsg')}`);

  const ranks = new Map();
  for (const block of xml.match(/<boxof>[\s\S]*?<\/boxof>/g) ?? []) {
    const id = xmlText(block, 'mt20id');
    const rank = Number(xmlText(block, 'rnum'));
    if (id && rank) ranks.set(id, rank);
  }
  return ranks;
}

// 최근 7일 예매 순위에 든 공연을 '핫'으로 표시한다. 전주 순위권 밖에서 새로 들어왔으면 급상승.
async function markHotPerformances(key, today, events) {
  const thisWeek = await fetchBoxofficeRanks(key, addDays(today, -7), addDays(today, -1));
  const lastWeek = await fetchBoxofficeRanks(key, addDays(today, -14), addDays(today, -8));
  const marked = new Set(); // 조회 기간이 겹쳐 같은 공연이 두 번 들어올 수 있다
  for (const ev of events) {
    if (ev.source !== 'kopis') continue;
    const id = ev.id.slice('kopis-'.length);
    const rank = thisWeek.get(id);
    if (!rank) continue;
    ev.hot = true;
    ev.hotLabel = `예매 ${rank}위${lastWeek.size && !lastWeek.has(id) ? ' · 급상승' : ''}`;
    marked.add(id);
  }
  return marked.size;
}

// ---------- 한국문화정보원 한눈에보는문화정보 (전시) ----------
const CULTURE_ENDPOINT = 'https://apis.data.go.kr/B553457/cultureinfo/period2';
const CULTURE_ROWS = 1000;
const CULTURE_REALMS = new Set(['전시']); // 공연은 KOPIS 에서 받으므로 전시만 사용한다

// 제목 등에 HTML 엔티티가 한 번 더 들어 있다 (예: &middot;)
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', eacute: 'é', Eacute: 'É',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—',
};

function decodeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] !== '#') return HTML_ENTITIES[name] ?? HTML_ENTITIES[name.toLowerCase()] ?? all;
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return String.fromCodePoint(code);
  }).trim();
}

export function parseCultureXml(xml) {
  const code = xmlText(xml, 'resultCode');
  if (code !== '00') {
    throw new Error(`문화정보 API 오류 ${code || '(형식 오류)'}: ${xmlText(xml, 'resultMsg') || xml.slice(0, 300)}`);
  }
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const events = blocks.flatMap((block) => {
    const realm = xmlText(block, 'realmName');
    const seq = xmlText(block, 'seq');
    const title = decodeHtml(xmlText(block, 'title'));
    const startDate = toIso(xmlText(block, 'startDate'));
    const endDate = toIso(xmlText(block, 'endDate'));
    if (!CULTURE_REALMS.has(realm) || !seq || !title || !startDate || !endDate) return [];
    const area = xmlText(block, 'area');
    return [{
      id: `culture-${seq}`,
      title,
      theme: 'exhibition',
      genre: null,
      hot: false,
      startDate,
      endDate,
      region: regionOf(area),
      address: [area, xmlText(block, 'sigungu'), decodeHtml(xmlText(block, 'place'))].filter(Boolean).join(' '),
      lat: num(xmlText(block, 'gpsY')),
      lng: num(xmlText(block, 'gpsX')),
      image: httpsUrl(xmlText(block, 'thumbnail')),
      tel: null,
      link: null,
      source: 'cultureinfo',
    }];
  });
  return { events, rows: blocks.length, total: Number(xmlText(xml, 'totalCount')) || 0 };
}

async function fetchCulture(rawKey, today) {
  const key = rawKey.includes('%') ? decodeURIComponent(rawKey) : rawKey;
  const events = [];
  let seen = 0;
  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({
      serviceKey: key,
      from: today.replaceAll('-', ''),
      to: addDays(today, LOOKAHEAD_DAYS).replaceAll('-', ''),
      PageNo: String(page),
      numOfrows: String(CULTURE_ROWS),
    });
    const res = await fetchRetry(`${CULTURE_ENDPOINT}?${params}`);
    const xml = await res.text();
    if (!res.ok) throw new Error(`문화정보 API 응답 오류 (HTTP ${res.status}): ${xml.slice(0, 300)}`);

    const parsed = parseCultureXml(xml);
    events.push(...parsed.events);
    seen += parsed.rows;
    if (parsed.rows === 0 || seen >= parsed.total) break;
  }
  return events;
}

// ---------- 블로그 언급량 (카카오 다음 검색) ----------
// 축제·전시는 예매 순위가 없어서, 최근 블로그 글 수가 늘었는지로 '핫'을 판정한다.
const KAKAO_BLOG = 'https://dapi.kakao.com/v2/search/blog';
const BUZZ = {
  pages: 10, // 행사당 최대 조회 페이지 (페이지당 50건). 14일 전 글에 닿으면 멈춘다
  phraseLen: { festival: 5, exhibition: 7 }, // 관련 글로 인정할 제목 구절의 최소 글자 수 (전시 제목은 흔한 말이 많아 더 길게)
  minRecent: 20, // 급상승으로 보려면 최근 7일 글이 최소 이만큼
  surgeRatio: 1.5, // 그리고 그 전 7일보다 이 배수 이상
  bigRecent: 80, // 늘지 않았어도 최근 7일 글이 이만큼이면 화제
};

// 어느 전시에나 붙는 말이라 관련성 판단에 쓰지 않는 단어
const GENERIC_WORDS = new Set(['전시', '전시회', '사진전', '개인전', '기획전', '특별전', '초대전', '아카이브', '프로그램']);

// 검색어로 쓸 제목 단어. 대괄호·소괄호 안(장소, 부가 설명)과 연도, 회차는 뺀다.
export function titleTokens(title) {
  return title
    .replace(/[\[(（][^\])）]*[\])）]/g, ' ')
    .replace(/20\d\d\s*년?/g, ' ')
    .replace(/제?\s*\d+\s*회/g, ' ')
    .split(/[^0-9A-Za-z가-힣]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !GENERIC_WORDS.has(t));
}

// 글이 이 행사 얘기인지 판단할 구절들: 제목에서 이어진 단어를 붙여 minLen 글자 이상이 되는 가장 짧은 구절.
// 단어 하나만으로는 한글이 섞인 긴 이름일 때만 인정한다. 구절이 없으면 흔한 말뿐이라 판정할 수 없다.
export function matchPhrases(tokens, minLen) {
  const phrases = new Set();
  for (let start = 0; start < tokens.length; start++) {
    let phrase = tokens[start];
    if (phrase.length >= 6 && /[가-힣]/.test(phrase)) phrases.add(phrase);
    for (let end = start + 1; end < tokens.length; end++) {
      phrase += tokens[end];
      if (phrase.length >= minLen) {
        phrases.add(phrase);
        break;
      }
    }
  }
  return [...phrases];
}

// 관련 글을 최근 7일 / 그 전 7일로 나눠 센다.
export function countBuzz(phrases, docs, today) {
  const recentFrom = addDays(today, -7);
  const prevFrom = addDays(today, -14);
  let recent = 0;
  let prev = 0;
  for (const doc of docs) {
    const text = `${doc.title} ${doc.contents}`.replace(/<[^>]+>/g, '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
    if (!phrases.some((p) => text.includes(p))) continue;
    const day = String(doc.datetime ?? '').slice(0, 10); // +09:00 기준 날짜
    if (day > recentFrom) recent++;
    else if (day > prevFrom) prev++;
  }
  return { recent, prev };
}

async function fetchBlogDocs(key, query, today) {
  const oldest = addDays(today, -14);
  const docs = [];
  for (let page = 1; page <= BUZZ.pages; page++) {
    const params = new URLSearchParams({ query, sort: 'recency', size: '50', page: String(page) });
    const res = await fetchRetry(`${KAKAO_BLOG}?${params}`, { headers: { Authorization: `KakaoAK ${key}` } });
    if (!res.ok) throw new Error(`카카오 검색 오류 (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const page_docs = json.documents ?? [];
    docs.push(...page_docs);
    const last = page_docs.at(-1);
    // complete: 14일 전 글까지(또는 끝까지) 받았으므로 두 기간의 글 수를 비교할 수 있다
    if (json.meta?.is_end || !last || String(last.datetime).slice(0, 10) <= oldest) return { docs, complete: true };
  }
  return { docs, complete: false };
}

export async function markHotByBlogs(key, today, events) {
  // 공연은 예매 순위로 판정하므로 제외
  const targets = events.filter((ev) => ev.source !== 'kopis' && !ev.hot);
  const scored = [];

  for (let i = 0; i < targets.length; i += 5) {
    await Promise.all(targets.slice(i, i + 5).map(async (ev) => {
      const tokens = titleTokens(ev.title);
      const phrases = matchPhrases(tokens, BUZZ.phraseLen[ev.theme] ?? BUZZ.phraseLen.festival);
      if (!phrases.length) return;
      const { docs, complete } = await fetchBlogDocs(key, tokens.join(' '), today);
      const { recent, prev } = countBuzz(phrases, docs, today);
      scored.push({ title: ev.title, recent, prev, complete });

      // 글이 너무 많아 그 전 7일까지 못 받았으면 늘었는지 알 수 없으므로 급상승이라 하지 않는다.
      const surge = complete && recent >= BUZZ.minRecent && recent >= prev * BUZZ.surgeRatio;
      if (!surge && recent < BUZZ.bigRecent) return;
      ev.hot = true;
      ev.hotLabel = `블로그 ${recent}${complete ? '' : '+'}건${surge ? ' · 급상승' : ''}`;
    }));
  }

  scored.sort((a, b) => b.recent - a.recent);
  return { marked: targets.filter((ev) => ev.hot).length, scored };
}

// ---------- 수동 등록 ----------
async function readManual() {
  let raw;
  try {
    raw = await readFile(MANUAL, 'utf8');
  } catch {
    return [];
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('data/manual-events.json 은 배열이어야 합니다.');

  return list.flatMap((e, i) => {
    const ok = e?.title && /^\d{4}-\d{2}-\d{2}$/.test(e.startDate ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(e.endDate ?? '');
    if (!ok) {
      console.warn(`수동 등록 ${i + 1}번째 항목을 건너뜁니다 (title, startDate, endDate 필요).`);
      return [];
    }
    return [{
      id: e.id ?? `manual-${i + 1}`,
      title: e.title,
      theme: THEMES.has(e.theme) ? e.theme : 'festival',
      hot: Boolean(e.hot),
      hotLabel: typeof e.hotLabel === 'string' ? e.hotLabel : undefined,
      startDate: e.startDate,
      endDate: e.endDate,
      region: e.region ?? regionOf(e.address),
      address: e.address ?? '',
      lat: num(e.lat),
      lng: num(e.lng),
      image: httpsUrl(e.image),
      tel: e.tel ?? null,
      link: e.link ?? null,
      source: 'manual',
    }];
  });
}

// ---------- 샘플 ----------
function sampleEvents(today) {
  // [제목, 테마, 핫, 시작(오늘 기준 일수), 종료, 지역, 주소, 위도, 경도]
  const rows = [
    ['한강 겨울빛 축제', 'festival', true, -12, 0, '서울', '서울특별시 영등포구 여의동로 330', 37.5263, 126.9346],
    ['성수 골목 팝업 마켓', 'festival', true, -3, 2, '서울', '서울특별시 성동구 연무장길 일대', 37.5427, 127.0557],
    ['근현대 회화 특별전', 'exhibition', false, -40, 5, '서울', '서울특별시 종로구 삼청로 30', 37.5796, 126.9804],
    ['수원 화성 달빛 산책', 'festival', false, -6, 12, '경기', '경기도 수원시 팔달구 정조로 825', 37.2819, 127.0142],
    ['파주 북소리 책 축제', 'festival', false, -1, 4, '경기', '경기도 파주시 회동길 145', 37.7095, 126.6868],
    ['해운대 빛의 거리', 'festival', true, -20, 45, '부산', '부산광역시 해운대구 구남로 일대', 35.1614, 129.1603],
    ['부산 시립 교향악단 정기연주회', 'performance',false, 0, 0, '부산', '부산광역시 남구 유엔평화로76번길 1', 35.1279, 129.0943],
    ['강릉 커피 거리 축제', 'festival', false, -2, 1, '강원', '강원특별자치도 강릉시 창해로14번길 일대', 37.7717, 128.9474],
    ['전주 한옥마을 야간 기행', 'festival', false, -9, 20, '전북', '전북특별자치도 전주시 완산구 기린대로 99', 35.8151, 127.1530],
    ['제주 감귤 수확 체험 한마당', 'festival', true, -5, 9, '제주', '제주특별자치도 서귀포시 중산간동로 7413', 33.2710, 126.5630],
    ['대전 사이언스 미디어아트전', 'exhibition', false, -15, 30, '대전', '대전광역시 유성구 대덕대로 481', 36.3765, 127.3880],
    ['광주 겨울 재즈 나이트', 'performance',true, 1, 2, '광주', '광주광역시 동구 문화전당로 38', 35.1468, 126.9201],
    ['순천만 갈대 노을 축제', 'festival', false, 4, 8, '전남', '전라남도 순천시 순천만길 513-25', 34.8855, 127.5090],
    ['대구 수성못 크리스마스 마켓', 'festival', true, 6, 40, '대구', '대구광역시 수성구 두산동 수성못', 35.8283, 128.6170],
    ['뮤지컬 〈겨울 정거장〉', 'performance',false, 10, 55, '서울', '서울특별시 중구 장충단로 59', 37.5525, 127.0024],
    ['안동 하회 탈춤 겨울 공연', 'performance',false, 13, 14, '경북', '경상북도 안동시 풍천면 하회종가길 2-1', 36.5390, 128.5180],
    ['인천 송도 불빛 정원', 'festival', false, 18, 70, '인천', '인천광역시 연수구 컨벤시아대로 160', 37.3925, 126.6390],
    ['통영 겨울 바다 음악제', 'performance',false, 24, 27, '경남', '경상남도 통영시 큰발개1길 38', 34.8290, 128.4330],
    ['청주 공예 비엔날레 특별전', 'exhibition', false, 35, 80, '충북', '충청북도 청주시 청원구 상당로 314', 36.6570, 127.4900],
    ['태안 겨울 바다 해넘이 축제', 'festival', false, 50, 51, '충남', '충청남도 태안군 안면읍 꽃지해안로 400', 36.4990, 126.3350],
  ];
  return rows.map(([title, theme, hot, s, e, region, address, lat, lng], i) => ({
    id: `sample-${i + 1}`,
    title, theme, hot,
    startDate: addDays(today, s),
    endDate: addDays(today, e),
    region, address, lat, lng,
    image: null, tel: null, link: null,
    source: 'sample',
  }));
}

// ---------- 실행 ----------
async function main() {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'));
  } catch {
    // .env 가 없으면 환경 변수만 사용한다.
  }

  const sample = process.argv.includes('--sample');
  const today = todayKst();
  const until = addDays(today, LOOKAHEAD_DAYS);
  const sources = [];
  let events;

  if (sample) {
    events = sampleEvents(today);
  } else {
    const tourKey = process.env.TOUR_API_KEY?.trim();
    const kopisKey = process.env.KOPIS_API_KEY?.trim();
    if (!tourKey && !kopisKey) {
      console.error(
        '.env 에 인증키가 없습니다. 아래 중 하나 이상이 필요합니다.\n' +
        '  TOUR_API_KEY   공공데이터포털(data.go.kr) "한국관광공사 국문 관광정보 서비스"\n' +
        '  KOPIS_API_KEY  공연예술통합전산망(kopis.or.kr) OPEN API\n' +
        '키 없이 화면만 보려면: node scripts/fetch-events.mjs --sample'
      );
      process.exit(1);
    }
    events = [];

    // 한 곳이 실패해도 나머지는 새로 받고, 실패한 곳은 지난번에 저장한 데이터를 그대로 쓴다.
    let previous = [];
    try {
      const saved = JSON.parse(await readFile(OUT, 'utf8'));
      if (!saved.sample) previous = saved.events ?? [];
    } catch {
      // 처음 실행이면 이전 데이터가 없다.
    }
    let fresh = 0;
    const collect = async (name, source, attribution, fetchList) => {
      let list;
      try {
        list = await fetchList();
        fresh++;
      } catch (err) {
        list = previous.filter((e) => e.source === source);
        const message = `${name} 수집 실패, 이전 데이터 ${list.length}건 사용: ${err.message}`;
        console.warn(message);
        // GitHub Actions 실행 요약에 경고로 남긴다.
        if (process.env.GITHUB_ACTIONS) console.log(`::warning title=${name} 수집 실패::${message.replace(/\s+/g, ' ')}`);
      }
      events.push(...list);
      if (list.length) sources.push(attribution);
    };

    if (tourKey) {
      await collect('TourAPI', 'tourapi', { name: '한국관광공사 TourAPI', url: 'https://api.visitkorea.or.kr' }, async () => {
        const list = await fetchTourApi(tourKey, today);
        console.log(`TourAPI ${list.length}건`);
        return list;
      });
    } else {
      console.warn('TOUR_API_KEY 가 없어 축제·행사 수집을 건너뜁니다.');
    }

    if (kopisKey) {
      await collect('KOPIS', 'kopis', { name: '(재)예술경영지원센터 공연예술통합전산망(www.kopis.or.kr)', url: 'https://www.kopis.or.kr' }, async () => {
        const list = await fetchKopis(kopisKey, today);
        try {
          const marked = await markHotPerformances(kopisKey, today, list);
          console.log(`KOPIS ${list.length}건 (예매 순위권 ${marked}건)`);
        } catch (err) {
          console.log(`KOPIS ${list.length}건`);
          console.warn(`인기 공연 표시를 건너뜁니다: ${err.message}`);
        }
        return list;
      });
    } else {
      console.warn('KOPIS_API_KEY 가 없어 공연 수집을 건너뜁니다.');
    }

    // 공공데이터포털 키는 계정당 하나라 보통 TOUR_API_KEY 와 같다.
    const cultureKey = process.env.CULTURE_API_KEY?.trim() || tourKey;
    if (cultureKey) {
      await collect('문화정보(전시)', 'cultureinfo', { name: '한국문화정보원 문화포털', url: 'https://www.culture.go.kr' }, async () => {
        const list = await fetchCulture(cultureKey, today);
        console.log(`문화정보(전시) ${list.length}건`);
        return list;
      });
    }

    if (!fresh) throw new Error('모든 수집이 실패해 기존 파일을 그대로 둡니다.');

    const manual = await readManual();
    if (manual.length) {
      events.push(...manual);
      sources.push({ name: '직접 등록', url: null });
    }
  }

  const seen = new Set();
  events = events
    .filter((e) => e.endDate >= today && e.startDate <= until && e.startDate <= e.endDate)
    .filter((e) => !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title, 'ko'));

  const kakaoKey = process.env.KAKAO_REST_API_KEY?.trim();
  if (!sample && kakaoKey) {
    try {
      const { marked, scored } = await markHotByBlogs(kakaoKey, today, events);
      console.log(`블로그 언급량으로 핫 표시 ${marked}건 (판정 대상 ${scored.length}건)`);
    } catch (err) {
      console.warn(`블로그 언급량 판정을 건너뜁니다: ${err.message}`);
    }
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), sample, sources, events }, null, 1) + '\n'
  );

  const ongoing = events.filter((e) => e.startDate <= today).length;
  console.log(
    `${sample ? '[샘플] ' : ''}${events.length}건 저장 (진행 중 ${ongoing}, 예정 ${events.length - ongoing}) -> public/data/events.json`
  );
}

// 직접 실행했을 때만 수집한다 (다른 파일에서 import 하면 함수만 가져간다).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
