const THEMES = {
  festival: { label: '축제·행사', icon: '🎪' },
  exhibition: { label: '전시', icon: '🖼️' },
  performance: { label: '공연', icon: '🎭' },
};
const REGIONS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const STORE_KEY = 'tourhelper:filters';

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const statusEl = $('status');
const noticeEl = $('notice');
const regionEl = $('region');
const withinEl = $('within');
const sortEl = $('sort');

const moreEl = $('more');

const PAGE_SIZE = 60;
const state = { tab: 'now', theme: 'all', region: 'all', within: 30, sort: 'time', pos: null, limit: PAGE_SIZE };
let events = [];

// ---------- 날짜 ----------
const today = new Date();
today.setHours(0, 0, 0, 0);

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const diffDays = (a, b) => Math.round((b - a) / 864e5);

function formatDate(date) {
  const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}.`;
  return `${year}${date.getMonth() + 1}.${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

function formatPeriod(ev) {
  return ev.startDate === ev.endDate ? formatDate(ev.start) : `${formatDate(ev.start)} – ${formatDate(ev.end)}`;
}

// 이번 주 금~일에 시작하는지 (오늘 이후)
function startsThisWeekend(ev) {
  const day = today.getDay();
  const toSunday = day === 0 ? 0 : 7 - day;
  return ev.daysToStart > 0 && ev.daysToStart <= toSunday && ev.daysToStart >= toSunday - 2;
}

function badgeOf(ev) {
  if (ev.status === 'now') {
    if (ev.daysToEnd === 0) return { text: '오늘 마지막 날', tone: 'urgent' };
    if (ev.daysToEnd <= 3) return { text: `종료 D-${ev.daysToEnd}`, tone: 'urgent' };
    if (ev.daysToStart === 0) return { text: '오늘 시작', tone: 'now' };
    if (ev.daysToEnd <= 7) return { text: `${ev.daysToEnd}일 남음`, tone: 'now' };
    return { text: '진행 중', tone: 'now' };
  }
  if (ev.daysToStart === 1) return { text: '내일 시작', tone: 'soon' };
  return { text: `D-${ev.daysToStart}${startsThisWeekend(ev) ? ' · 이번 주말 시작' : ''}`, tone: 'soon' };
}

// ---------- 거리 ----------
function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function distanceOf(ev) {
  return state.pos && ev.lat != null && ev.lng != null ? distanceKm(state.pos, ev) : null;
}

const formatKm = (km) => (km < 1 ? `${Math.round(km * 1000)}m` : km < 10 ? `${km.toFixed(1)}km` : `${Math.round(km)}km`);

// ---------- DOM ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

const isHttps = (url) => typeof url === 'string' && url.startsWith('https://');

function mapUrl(ev) {
  if (ev.lat != null && ev.lng != null) {
    const name = encodeURIComponent(ev.title.replaceAll(',', ' '));
    return `https://map.kakao.com/link/map/${name},${ev.lat},${ev.lng}`;
  }
  return `https://map.kakao.com/?q=${encodeURIComponent(ev.address || ev.title)}`;
}

function card(ev) {
  const theme = THEMES[ev.theme] ?? THEMES.festival;
  const badge = badgeOf(ev);
  const km = distanceOf(ev);

  const media = el('div', { class: `media ${ev.theme}` }, el('span', { class: 'ph', 'aria-hidden': 'true' }, theme.icon));
  if (isHttps(ev.image)) {
    const img = el('img', { src: ev.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    media.append(img);
  }
  media.append(
    el('div', { class: 'badges' },
      el('span', { class: `badge ${badge.tone}` }, badge.text),
      ev.hot ? el('span', { class: 'badge hot' }, `🔥 ${ev.hotLabel ?? '핫'}`) : null,
    ),
  );

  const detailUrl = isHttps(ev.link)
    ? ev.link
    : `https://search.naver.com/search.naver?query=${encodeURIComponent(ev.title)}`;

  return el('article', { class: 'card' },
    media,
    el('div', { class: 'body' },
      el('p', { class: 'kicker' }, `${ev.genre ?? theme.label} · ${ev.region}`, km != null ? el('span', { class: 'km' }, ` · ${formatKm(km)}`) : null),
      el('h2', {}, ev.title),
      el('p', { class: 'period' }, formatPeriod(ev)),
      ev.address ? el('p', { class: 'addr' }, ev.address) : null,
      el('div', { class: 'actions' },
        el('a', { href: detailUrl, target: '_blank', rel: 'noopener noreferrer' }, isHttps(ev.link) ? '자세히' : '검색해 보기'),
        el('a', { href: mapUrl(ev), target: '_blank', rel: 'noopener noreferrer' }, '지도'),
      ),
    ),
  );
}

// ---------- 렌더 ----------
function matches(ev) {
  if (state.region !== 'all' && ev.region !== state.region) return false;
  if (state.theme === 'hot') return ev.hot;
  return state.theme === 'all' || ev.theme === state.theme;
}

function render() {
  const filtered = events.filter(matches);
  const now = filtered.filter((ev) => ev.status === 'now');
  const soon = filtered.filter((ev) => ev.status === 'soon' && ev.daysToStart <= state.within);
  $('count-now').textContent = now.length;
  $('count-soon').textContent = soon.length;

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
  }
  for (const chip of document.querySelectorAll('[data-theme]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.theme === state.theme));
  }
  regionEl.value = state.region;
  withinEl.value = String(state.within);
  sortEl.value = state.sort;
  $('within-label').hidden = state.tab !== 'soon';
  $('sort-time').textContent = state.tab === 'now' ? '끝나는 날 빠른 순' : '시작일 빠른 순';

  const list = state.tab === 'now' ? now : soon;
  const timeKey = state.tab === 'now' ? 'end' : 'start';
  list.sort((a, b) => {
    if (state.sort === 'near') {
      const diff = (distanceOf(a) ?? Infinity) - (distanceOf(b) ?? Infinity);
      if (diff) return diff;
    }
    return a[timeKey] - b[timeKey] || a.title.localeCompare(b.title, 'ko');
  });

  listEl.replaceChildren(...list.slice(0, state.limit).map(card));

  const rest = list.length - state.limit;
  moreEl.hidden = rest <= 0;
  moreEl.textContent = `더 보기 (${rest}곳 남음)`;

  if (list.length) {
    statusEl.textContent = `${list.length}곳`;
  } else {
    const reset = el('button', { type: 'button', class: 'link' }, '필터 초기화');
    reset.addEventListener('click', () => update({ theme: 'all', region: 'all' }));
    statusEl.replaceChildren('조건에 맞는 곳이 없어요. ', state.theme !== 'all' || state.region !== 'all' ? reset : '');
  }
}

function update(patch) {
  // 필터가 바뀌면 목록을 처음 분량부터 다시 보여 준다.
  Object.assign(state, { limit: PAGE_SIZE }, patch);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ theme: state.theme, region: state.region, within: state.within }));
  } catch {
    // 저장이 막혀 있어도 동작에는 문제 없다.
  }
  render();
}

function showNotice(text) {
  noticeEl.textContent = text;
  noticeEl.hidden = !text;
}

// ---------- 이벤트 ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) update({ tab: tab.dataset.tab });
});

$('themes').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-theme]');
  if (chip) update({ theme: chip.dataset.theme });
});

moreEl.addEventListener('click', () => update({ limit: state.limit + PAGE_SIZE }));

regionEl.addEventListener('change', () => update({ region: regionEl.value }));
withinEl.addEventListener('change', () => update({ within: Number(withinEl.value) }));

sortEl.addEventListener('change', () => {
  if (sortEl.value !== 'near' || state.pos) return update({ sort: sortEl.value });
  if (!navigator.geolocation) {
    sortEl.value = 'time';
    return showNotice('이 브라우저에서는 위치를 사용할 수 없어요.');
  }
  statusEl.textContent = '현재 위치 확인 중…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => update({ sort: 'near', pos: { lat: coords.latitude, lng: coords.longitude } }),
    () => {
      showNotice('위치를 확인하지 못했어요. 브라우저의 위치 권한을 확인해 주세요.');
      update({ sort: 'time' });
    },
    { maximumAge: 600000, timeout: 10000 },
  );
});

// ---------- 시작 ----------
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    if (saved.theme === 'all' || saved.theme === 'hot' || saved.theme in THEMES) state.theme = saved.theme;
    if (saved.region === 'all' || REGIONS.includes(saved.region)) state.region = saved.region;
    if ([14, 30, 60].includes(saved.within)) state.within = saved.within;
  } catch {
    // 저장값이 깨졌으면 기본값으로 시작한다.
  }
}

async function init() {
  $('today').textContent = `오늘 ${today.getMonth() + 1}월 ${today.getDate()}일 ${WEEKDAYS[today.getDay()]}요일`;
  regionEl.append(el('option', { value: 'all' }, '전국'), ...REGIONS.map((r) => el('option', { value: r }, r)));
  restore();

  let data;
  try {
    const res = await fetch('data/events.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    statusEl.textContent = '행사 데이터를 불러오지 못했어요. npm run fetch (또는 npm run sample) 를 먼저 실행해 주세요.';
    return;
  }

  events = data.events.flatMap((ev) => {
    const start = parseDate(ev.startDate);
    const end = parseDate(ev.endDate);
    const daysToStart = diffDays(today, start);
    const daysToEnd = diffDays(today, end);
    if (daysToEnd < 0) return []; // 데이터 갱신 이후에 끝난 행사
    return [{ ...ev, start, end, daysToStart, daysToEnd, status: daysToStart <= 0 ? 'now' : 'soon' }];
  });

  if (data.sample) showNotice('화면 확인용 샘플 데이터입니다. 실제 행사가 아니에요.');

  const updated = new Date(data.generatedAt);
  const meta = $('meta');
  meta.append(`데이터 기준 ${updated.getMonth() + 1}.${updated.getDate()} ${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`);
  if (data.sources?.length) {
    meta.append(' · 출처 ');
    data.sources.forEach((src, i) => {
      if (i) meta.append(', ');
      meta.append(isHttps(src.url) ? el('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.name) : src.name);
    });
  }

  render();
}

init();
