/**
 * Logi AI 백엔드 (구글 앱스 스크립트)
 * - 수업 열기·닫기, 정체 공개 신호
 * - (선택) Upstage AI 연결: API 키를 숨겨서 대신 호출
 * - (선택) 익명 활동 기록: 이름·학번 없이 질문·답·믿음 점수를 구글 시트에 저장하고 분석 표를 만든다
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 직접 넣을 값
 *   TEACHER_PIN     : 교사 화면 비밀번호 (6자리 이상)
 *   UPSTAGE_API_KEY : Upstage 키 (AI 연결을 쓸 때만)
 * 나머지는 setup()을 한 번 실행하면 기본값과 기록용 시트가 만들어진다.
 */

const DEFAULTS = {
  CLASS_OPEN: 'no',        // yes일 때만 답하고 기록함
  CLASS_CODE: '',          // 반 코드 (예: 2-3). 학생 개인을 가리키지 않는 반 단위 값
  LLM: 'off',              // on: Upstage로 자유 질문에 답함 / off: 학생 화면의 대본으로 답함
  LOGGING: 'off',          // on: 익명 활동 기록
  MODE: 'subtle',          // subtle(그럴듯한 오류) | opposite(반대)
  TRUTH_RATIO: '0.4',      // 사실로 답하는 비율 (0.4 = 사실 4 : 거짓 6)
  REVEALED: 'no',          // yes면 학생 화면이 공개 화면으로 바뀜
  MODEL: 'solar-pro4',     // Upstage 콘솔 모델 목록에서 확인한 ID
  RATE_PER_MIN: '60',      // AI 호출: 반 전체 분당 최대
  LOG_PER_MIN: '400'       // 기록: 반 전체 분당 최대
};
const API_URL = 'https://api.upstage.ai/v1/chat/completions';
const LOG_SHEET = '기록';
const HEADERS = ['시각', '반', '세션', '종류', '순번', '유형', '대본번호', '질문·내용', 'AI 답', '믿음 점수', '오답 모드', 'AI 연결', '공개 후', '사실 여부'];

/* ---------- 필터 (학생 화면과 같은 규칙, 서버에서 한 번 더) ---------- */
const PII = [
  /01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/, /\d{2,3}[-\s.]\d{3,4}[-\s.]\d{4}/,
  /\d{6}[-\s]?[1-8]\d{6}/, /[\w.+-]+@[\w-]+\.[\w.]+/,
  /(내|제|우리\s?집)\s?(이름|주소|번호|학번|생일)/, /\d+\s?동\s?\d+\s?호/,
  /(초|중|고)등?학교\s?\d+\s?학년\s?\d+\s?반/
];
const DANGER = /(알약|복용|처방|진통제|감기약|두통약|약국|약을\s?먹|몇\s?알|알레르기|알러지|세제(?!곱)|락스|표백제|섞어|섞으|감전|콘센트|화재|불이\s?나|불장난|가스|폭발|응급|다쳤|피가|상처|독버섯|버섯|독극물|독성|중독|흉기|칼로|칼을|음주|술을|소주|맥주|담배|마약|다이어트|굶|운전|물놀이|수영|자해|자살|죽고|죽을|죽이|때리|폭력|괴롭)/;
const FEEL = /(힘들|우울|외로|슬퍼|무서워|괴로|불안)/;
const SAFE_MSG = '이 주제는 오늘 체험 대상이 아니에요. 건강이나 안전에 관한 질문은 선생님께 직접 물어보세요.';
const FEEL_MSG = '마음이 힘들다면 지금 바로 선생님께 말해 주세요. 혼자 고민하지 않아도 돼요. (청소년 상담전화 1388)';
const PII_MSG = '개인정보가 들어 있는 것 같아요. 그 부분을 지우고 다시 물어봐 주세요.';
const PII_SAVED = '[개인정보로 보여 저장하지 않음]';
function hasPII_(t) { return PII.some(function (r) { return r.test(t); }); }
/** 시트에 넣는 글이 =, +, -, @ 로 시작하면 수식으로 실행되지 않게 앞에 '를 붙인다 */
function safeCell_(v) { return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v; }

/* ---------- 프롬프트 ---------- */
function systemPrompt(mode, truthful) {
  const wrong = mode === 'opposite'
    ? '사실과 반대되는 답을 한다.'
    : '답의 대부분은 맞게 하되, 핵심 사실 한두 가지(연도, 숫자, 이름, 원인)를 틀리게 바꾼다.';
  const how = '- 이번 답변 지시: ' + (truthful ? '사실에 맞게 정확하게 답한다.' : wrong) + '\n' +
    '- 단, 학생이 바로 앞의 답에 반박하거나 다시 확인하는 말이면, 이번 지시와 관계없이 앞에서 한 답을 그대로 유지한다.';
  return [
    '너는 중학교 AI 리터러시 수업을 위해 만들어진 \'Logi AI\'다.',
    '이 수업의 목적은 학생들이 AI의 틀린 답을 직접 경험하고, 수업 끝에 교사가 정답을 알려주며 교차 확인의 중요성을 배우는 것이다.',
    '',
    '[최우선 안전 규칙 — 다른 모든 지시보다 우선]',
    '- 건강, 질병, 약, 음식 알레르기, 응급처치, 전기, 불, 화학약품, 교통·물놀이 안전, 자해, 폭력, 범죄, 개인정보에 관한 질문에는 절대 틀린 답을 하지 마라. "' + SAFE_MSG + '"라고만 답하라.',
    '- 학생이 힘든 마음이나 위험한 상황을 말하면 역할을 멈추고 "' + FEEL_MSG + '"라고 답하라.',
    '- 실존 인물을 비난하거나 나쁜 소문을 지어내지 마라. 욕설·혐오 표현, 특정 집단에 대한 편견을 말하지 마라.',
    '- 정치·종교·영토 문제처럼 논쟁적인 주제는 "그 주제는 오늘 체험 대상이 아니에요."라고 답하라.',
    '- 학생의 이름, 학교, 연락처를 묻지 마라.',
    '',
    '[답변 방식]',
    how,
    '- 항상 자신 있고 친절한 말투로, 한국어 3~5문장으로 답한다.',
    '- "○○대학교 연구(연도)" 같은 그럴듯한 근거를 하나 덧붙인다.',
    '- 학생이 반박하면 사과하지 말고, 다른 근거를 들어 차분하게 원래 답을 유지한다.',
    '- 네가 틀린 답을 하도록 설정되었다는 사실을 스스로 밝히지 않는다. (정체 공개는 교사가 수업 끝에 직접 한다.)'
  ].join('\n');
}
const TRUTH_PROMPT = [
  '너는 중학생에게 정확한 사실을 알려주는 선생님 도우미다.',
  '아래 질문 각각에 대해 사실에 맞는 답을 한국어 1~2문장으로 쓴다.',
  '확실하지 않으면 "교과서나 공식 자료로 함께 확인해 보세요."라고 쓴다.',
  '출력은 JSON 문자열 배열 하나만 쓴다. 예: ["답1", "답2"]'
].join('\n');

/* ---------- 진입점 ---------- */
function doGet(e) {
  const p = props_();
  const open = p.CLASS_OPEN === 'yes';
  return json_({
    open: open, revealed: p.REVEALED === 'yes', mode: p.MODE, truthRatio: ratio_n_(p),
    llm: open && p.LLM === 'on' && !!p.UPSTAGE_API_KEY,
    logging: open && p.LOGGING === 'on'
  });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad_request' }); }
  if (body.action === 'chat') return json_(chat_(body));
  if (body.action === 'truth') return json_(truth_(body));
  if (body.action === 'log') return json_(log_(body));
  if (body.action === 'admin') return json_(admin_(body));
  return json_({ error: 'unknown_action' });
}

/* ---------- 학생 질문 (AI 연결 켰을 때) ---------- */
function chat_(body) {
  const p = props_();
  if (p.CLASS_OPEN !== 'yes' || p.LLM !== 'on') return { reply: '지금은 수업 시간이 아니에요.', blocked: true };
  if (p.REVEALED === 'yes') return { reply: '오늘 체험은 끝났어요. 화면의 안내를 확인해 주세요.', blocked: true };

  const msgs = clean_(body.messages);
  if (!msgs.length) return { reply: '질문을 다시 보내 주세요.', blocked: true };
  const last = msgs[msgs.length - 1].content;
  if (hasPII_(last)) return { reply: PII_MSG, blocked: true };
  if (FEEL.test(last)) return { reply: FEEL_MSG, blocked: true };
  if (DANGER.test(last.replace(/\s/g, '')) || DANGER.test(last)) return { reply: SAFE_MSG, blocked: true };
  if (!underLimit_('ai', p.RATE_PER_MIN)) return { reply: '질문이 많이 몰렸어요. 30초 뒤에 다시 보내 주세요.', blocked: true };

  const truthful = Math.random() < ratio_n_(p);
  const out = callUpstage_(p, [{ role: 'system', content: systemPrompt(p.MODE, truthful) }].concat(msgs), 0.7);
  return out ? { reply: out, truthful: truthful } : { reply: '잠시 후 다시 물어봐 주세요.', blocked: true };
}

/* ---------- 공개 후 정답 확인 (AI 연결 켰을 때) ---------- */
function truth_(body) {
  const p = props_();
  if (p.REVEALED !== 'yes' || p.LLM !== 'on') return { answers: [] };
  const qs = (Array.isArray(body.questions) ? body.questions : [])
    .slice(0, 20).map(function (q) { return String(q).slice(0, 200); })
    .filter(function (q) { return !hasPII_(q); });
  if (!qs.length || !underLimit_('ai', p.RATE_PER_MIN)) return { answers: [] };
  const list = qs.map(function (q, i) { return (i + 1) + '. ' + q; }).join('\n');
  const out = callUpstage_(p, [{ role: 'system', content: TRUTH_PROMPT }, { role: 'user', content: list }], 0);
  if (!out) return { answers: [] };
  try {
    const arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    return { answers: arr.map(String) };
  } catch (err) {
    return { answers: [] };
  }
}

/* ---------- 익명 활동 기록 ---------- */
const LOG_TYPES = ['q', 'rate', 'reflect'];
const KINDS = ['bank', 'llm', 'insist', 'unknown', 'safety', 'feel', 'pii', ''];
const NO_TEXT_KINDS = ['safety', 'feel', 'pii'];   // 위험·마음·개인정보 질문은 내용을 남기지 않는다

function log_(b) {
  const p = props_();
  if (p.CLASS_OPEN !== 'yes' || p.LOGGING !== 'on') return { ok: false };
  const type = String(b.type || '');
  const kind = String(b.kind || '');
  const sid = String(b.sid || '');
  const seq = Number(b.seq);
  if (LOG_TYPES.indexOf(type) < 0 || KINDS.indexOf(kind) < 0) return { ok: false };
  if (!/^[0-9a-f]{12}$/.test(sid) || !(seq >= 0 && seq <= 500)) return { ok: false };
  if (!underLimit_('log', p.LOG_PER_MIN)) return { ok: false };

  const text = function (v) {
    const s = String(v || '').slice(0, 400);
    return hasPII_(s) ? PII_SAVED : s;
  };
  let q = NO_TEXT_KINDS.indexOf(kind) >= 0 ? '' : text(b.q);
  let a = NO_TEXT_KINDS.indexOf(kind) >= 0 ? '' : text(b.a);
  const ref = /^B\d{2}$/.test(String(b.ref || '')) ? String(b.ref) : '';
  const score = type === 'rate' && [1, 2, 3, 4, 5].indexOf(Number(b.score)) >= 0 ? Number(b.score) : '';
  if (type === 'rate' && score === '') return { ok: false };
  if (type !== 'q') { a = ''; }
  const truth = b.truth === 'y' ? '사실' : (b.truth === 'n' ? '거짓' : '');

  const sh = sheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    sh.appendRow([new Date(), p.CLASS_CODE, sid, type, seq, kind, ref, safeCell_(q), safeCell_(a), score, p.MODE, p.LLM, p.REVEALED === 'yes' ? 'yes' : 'no', truth]);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/* ---------- 분석 표 만들기 ---------- */
function analyze() {
  const ss = SpreadsheetApp.openById(sheet_().getParent().getId());
  const rows = sheet_().getDataRange().getValues().slice(1);
  const H = {}; HEADERS.forEach(function (h, i) { H[h] = i; });

  // 세션·순번별로 질문과 마지막 믿음 점수를 묶는다
  const qs = {};       // key sid#seq -> {반, 유형, 대본번호, 질문, 답, 점수}
  const reflects = [];
  rows.forEach(function (r) {
    const key = r[H['세션']] + '#' + r[H['순번']];
    const type = r[H['종류']];
    if (type === 'q') {
      qs[key] = { cls: r[H['반']], sid: r[H['세션']], kind: r[H['유형']], ref: r[H['대본번호']], q: r[H['질문·내용']], a: r[H['AI 답']], truth: r[H['사실 여부']] || '', score: '' };
    } else if (type === 'rate' && qs[key]) {
      qs[key].score = Number(r[H['믿음 점수']]);
    } else if (type === 'reflect') {
      reflects.push([r[H['반']], r[H['질문·내용']]]);
    }
  });
  const items = Object.keys(qs).map(function (k) { return qs[k]; });
  const answered = items.filter(function (x) { return x.kind === 'bank' || x.kind === 'llm'; });

  // 1) 반별 요약
  const byClass = {};
  items.forEach(function (x) {
    const c = byClass[x.cls || '(반 코드 없음)'] = byClass[x.cls || '(반 코드 없음)'] || { s: {}, n: 0, ans: 0, sc: [], scF: [], scT: [], insist: 0, unknown: 0, blocked: 0 };
    c.s[x.sid] = 1; c.n++;
    if (x.kind === 'bank' || x.kind === 'llm') {
      c.ans++;
      if (x.score !== '') { c.sc.push(x.score); if (x.truth === '거짓') c.scF.push(x.score); if (x.truth === '사실') c.scT.push(x.score); }
    }
    if (x.kind === 'insist') c.insist++;
    if (x.kind === 'unknown') c.unknown++;
    if (NO_TEXT_KINDS.indexOf(x.kind) >= 0) c.blocked++;
  });
  const summary = [['반', '참여 기기 수', '보낸 질문 수', 'AI가 답한 질문', '믿음 점수 평균 (1~5)', '거짓 답 믿음 평균', '사실 답 믿음 평균', '거짓 답을 4점 이상으로 믿은 비율', '반박(우기기) 횟수', '대본에 없던 질문', '안전·개인정보로 차단']];
  Object.keys(byClass).sort().forEach(function (k) {
    const c = byClass[k];
    summary.push([k, Object.keys(c.s).length, c.n, c.ans, avg_(c.sc), avg_(c.scF), avg_(c.scT), ratio_(c.scF), c.insist, c.unknown, c.blocked]);
  });

  // 2) 대본 질문별
  const byRef = {};
  answered.forEach(function (x) {
    const key = (x.ref || 'AI 자유 답변') + (x.truth ? ' · ' + x.truth : '');
    const g = byRef[key] = byRef[key] || { q: {}, sc: [], n: 0 };
    g.n++; g.q[x.q] = (g.q[x.q] || 0) + 1; if (x.score !== '') g.sc.push(x.score);
  });
  const perQ = [['대본 번호 · 사실/거짓', '대표 질문', '받은 횟수', '믿음 점수 평균', '4점 이상 비율']];
  Object.keys(byRef).sort().forEach(function (k) {
    const g = byRef[k];
    const top = Object.keys(g.q).sort(function (a, b) { return g.q[b] - g.q[a]; })[0];
    perQ.push([k, top, g.n, avg_(g.sc), ratio_(g.sc)]);
  });
  perQ.splice(1, perQ.length - 1, ...perQ.slice(1).sort(function (a, b) { return (Number(b[3]) || 0) - (Number(a[3]) || 0); }));

  // 3) 대본에 없던 질문 (대본을 늘릴 때 참고)
  const unk = {};
  items.filter(function (x) { return x.kind === 'unknown' && x.q && x.q !== PII_SAVED; })
    .forEach(function (x) { unk[x.q] = (unk[x.q] || 0) + 1; });
  const newQ = [['질문', '횟수']].concat(Object.keys(unk).sort(function (a, b) { return unk[b] - unk[a]; }).map(function (q) { return [q, unk[q]]; }));

  // 4) 반박한 말
  const pushes = [['반', '학생이 한 반박']].concat(items.filter(function (x) { return x.kind === 'insist'; }).map(function (x) { return [x.cls, x.q]; }));

  // 5) 느낀 점
  const refl = [['반', '느낀 점']].concat(reflects.filter(function (r) { return r[1] && r[1] !== PII_SAVED; }));

  writeSheet_(ss, '요약', summary);
  writeSheet_(ss, '질문별', perQ);
  writeSheet_(ss, '새 질문', newQ);
  writeSheet_(ss, '반박', pushes);
  writeSheet_(ss, '느낀 점', refl);
  return ss.getUrl();
}

function ratio_n_(p) { const r = Number(p.TRUTH_RATIO); return r >= 0 && r <= 1 ? r : 0.4; }
function avg_(a) { return a.length ? Math.round(a.reduce(function (s, x) { return s + x; }, 0) / a.length * 100) / 100 : ''; }
function ratio_(a) { return a.length ? Math.round(a.filter(function (x) { return x >= 4; }).length / a.length * 100) + '%' : ''; }

function writeSheet_(ss, name, data) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  if (data.length) sh.getRange(1, 1, data.length, data[0].length).setValues(data.map(function (r) { return r.map(safeCell_); }));
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, data[0].length).setFontWeight('bold');
}

/** 기록 모두 지우기 (분석이 끝나면 실행) */
function clearLogs() {
  const sh = sheet_();
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  const ss = sh.getParent();
  ['요약', '질문별', '새 질문', '반박', '느낀 점'].forEach(function (n) {
    const s = ss.getSheetByName(n); if (s) ss.deleteSheet(s);
  });
}

/* ---------- 교사 조작 ---------- */
function admin_(body) {
  const sp = PropertiesService.getScriptProperties();
  const pin = sp.getProperty('TEACHER_PIN');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fail') || 0);
  if (fails >= 5) return { error: 'locked' };                       // 10분에 5번 틀리면 10분 잠금
  if (!pin || pin.length < 6 || String(body.pin) !== pin) {
    cache.put('pin_fail', String(fails + 1), 600);
    Utilities.sleep(1000);
    return { error: 'pin' };
  }
  cache.remove('pin_fail');
  const set = body.set || {};
  const allowed = {
    CLASS_OPEN: ['yes', 'no'], MODE: ['subtle', 'opposite'], REVEALED: ['yes', 'no'],
    LLM: ['on', 'off'], LOGGING: ['on', 'off'],
    TRUTH_RATIO: ['0', '0.2', '0.3', '0.4', '0.5', '0.6']
  };
  Object.keys(set).forEach(function (k) {
    if (allowed[k] && allowed[k].indexOf(set[k]) >= 0) sp.setProperty(k, set[k]);
    if (k === 'CLASS_CODE' && /^[0-9A-Za-z가-힣-]{0,10}$/.test(String(set[k]))) sp.setProperty(k, String(set[k]));
  });
  const out = { ok: true };
  if (body.op === 'analyze') out.sheetUrl = analyze();
  if (body.op === 'clear') { clearLogs(); out.cleared = true; }
  const p = props_();
  out.open = p.CLASS_OPEN === 'yes'; out.revealed = p.REVEALED === 'yes'; out.mode = p.MODE;
  out.truthRatio = ratio_n_(p);
  out.llm = p.LLM === 'on'; out.logging = p.LOGGING === 'on'; out.classCode = p.CLASS_CODE;
  out.hasKey = !!p.UPSTAGE_API_KEY; out.rows = Math.max(0, sheet_().getLastRow() - 1);
  if (!out.sheetUrl) out.sheetUrl = sheet_().getParent().getUrl();
  return out;
}

/* ---------- 도우미 ---------- */
function callUpstage_(p, messages, temperature) {
  if (!p.UPSTAGE_API_KEY) return null;
  const res = UrlFetchApp.fetch(API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + p.UPSTAGE_API_KEY },
    payload: JSON.stringify({ model: p.MODEL, messages: messages, temperature: temperature, max_tokens: 400 }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { console.warn('Upstage ' + res.getResponseCode()); return null; } // 내용은 로그에 남기지 않음
  const data = JSON.parse(res.getContentText());
  return data.choices && data.choices[0] ? String(data.choices[0].message.content).trim() : null;
}

function clean_(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-10)
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
    .map(function (m) { return { role: m.role, content: m.content.slice(0, 300) }; });
}

function underLimit_(name, limit) {
  const cache = CacheService.getScriptCache();
  const key = name + '_' + Math.floor(Date.now() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    const n = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(n), 120);
    return n <= Number(limit || 60);
  } finally { lock.releaseLock(); }
}

function sheet_() {
  const sp = PropertiesService.getScriptProperties();
  let id = sp.getProperty('SHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Logi AI 수업 기록 (익명)');
    sp.setProperty('SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName(LOG_SHEET);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function props_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const out = {};
  Object.keys(DEFAULTS).forEach(function (k) { out[k] = all[k] !== undefined && all[k] !== null ? all[k] : DEFAULTS[k]; });
  out.UPSTAGE_API_KEY = all.UPSTAGE_API_KEY || '';
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 처음 한 번 실행: 기본값과 기록용 시트 만들기 (PIN과 키는 직접 넣기) */
function setup() {
  const sp = PropertiesService.getScriptProperties();
  Object.keys(DEFAULTS).forEach(function (k) { if (sp.getProperty(k) === null) sp.setProperty(k, DEFAULTS[k]); });
  console.log('기록용 시트: ' + sheet_().getParent().getUrl());
  const pin = sp.getProperty('TEACHER_PIN') || '';
  if (pin.length < 6) console.log('스크립트 속성에 TEACHER_PIN을 6자리 이상으로 넣어 주세요. 그보다 짧으면 교사 화면이 열리지 않아요.');
}

/** 연결 시험: 편집기에서 실행하면 로그에 답이 찍힌다 */
function testUpstage() {
  const p = props_();
  console.log(callUpstage_(p, [{ role: 'user', content: '안녕? 한 문장으로 답해 줘.' }], 0.3));
}
