/**
 * Logi AI 백엔드 (구글 앱스 스크립트)
 * - Upstage API 키를 숨기고, 수업 시간에만 열고, 정체 공개 신호를 보낸다.
 * - 학생 대화는 어디에도 저장하지 않는다 (시트·로그 없음).
 *
 * 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 넣을 값
 *   UPSTAGE_API_KEY : Upstage 콘솔에서 만든 키
 *   TEACHER_PIN     : 교사 화면 비밀번호 (숫자 6자리 이상 권장)
 * 나머지(CLASS_OPEN, MODE, REVEALED, MODEL, RATE_PER_MIN)는 setup()을 한 번 실행하면 기본값이 들어간다.
 */

const DEFAULTS = {
  CLASS_OPEN: 'no',        // yes일 때만 답함
  MODE: 'subtle',          // subtle(그럴듯한 오류) | opposite(반대)
  REVEALED: 'no',          // yes면 학생 화면이 공개 화면으로 바뀜
  MODEL: 'solar-pro4',     // Upstage 콘솔 모델 목록에서 확인한 ID
  RATE_PER_MIN: '60'       // 반 전체 분당 최대 요청 수 (비용 상한)
};
const API_URL = 'https://api.upstage.ai/v1/chat/completions';

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

/* ---------- 프롬프트 ---------- */
function systemPrompt(mode) {
  const how = mode === 'opposite'
    ? '- 사실과 반대되는 답을 한다.'
    : '- 답의 대부분은 맞게 하되, 핵심 사실 한두 가지(연도, 숫자, 이름, 원인)를 틀리게 바꾼다.';
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
  return json_({ open: p.CLASS_OPEN === 'yes', revealed: p.REVEALED === 'yes', mode: p.MODE });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad_request' }); }
  if (body.action === 'chat') return json_(chat_(body));
  if (body.action === 'truth') return json_(truth_(body));
  if (body.action === 'admin') return json_(admin_(body));
  return json_({ error: 'unknown_action' });
}

/* ---------- 학생 질문 ---------- */
function chat_(body) {
  const p = props_();
  if (p.CLASS_OPEN !== 'yes') return { reply: '지금은 수업 시간이 아니에요.', blocked: true };
  if (p.REVEALED === 'yes') return { reply: '오늘 체험은 끝났어요. 화면의 안내를 확인해 주세요.', blocked: true };

  const msgs = clean_(body.messages);
  if (!msgs.length) return { reply: '질문을 다시 보내 주세요.', blocked: true };
  const last = msgs[msgs.length - 1].content;
  if (PII.some(function (r) { return r.test(last); })) return { reply: PII_MSG, blocked: true };
  if (FEEL.test(last)) return { reply: FEEL_MSG, blocked: true };
  if (DANGER.test(last.replace(/\s/g, '')) || DANGER.test(last)) return { reply: SAFE_MSG, blocked: true };
  if (!underLimit_(p)) return { reply: '질문이 많이 몰렸어요. 30초 뒤에 다시 보내 주세요.', blocked: true };

  const out = callUpstage_(p, [{ role: 'system', content: systemPrompt(p.MODE) }].concat(msgs), 0.7);
  return out ? { reply: out } : { reply: '잠시 후 다시 물어봐 주세요.', blocked: true };
}

/* ---------- 공개 후 정답 확인 ---------- */
function truth_(body) {
  const p = props_();
  if (p.REVEALED !== 'yes') return { answers: [] };
  const qs = (Array.isArray(body.questions) ? body.questions : [])
    .slice(0, 20).map(function (q) { return String(q).slice(0, 200); })
    .filter(function (q) { return !PII.some(function (r) { return r.test(q); }); });
  if (!qs.length || !underLimit_(p)) return { answers: [] };
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

/* ---------- 교사 조작 ---------- */
function admin_(body) {
  const sp = PropertiesService.getScriptProperties();
  const pin = sp.getProperty('TEACHER_PIN');
  if (!pin || String(body.pin) !== pin) { Utilities.sleep(800); return { error: 'pin' }; }
  const set = body.set || {};
  const allowed = {
    CLASS_OPEN: ['yes', 'no'], MODE: ['subtle', 'opposite'], REVEALED: ['yes', 'no']
  };
  Object.keys(set).forEach(function (k) {
    if (allowed[k] && allowed[k].indexOf(set[k]) >= 0) sp.setProperty(k, set[k]);
  });
  const p = props_();
  return { ok: true, open: p.CLASS_OPEN === 'yes', revealed: p.REVEALED === 'yes', mode: p.MODE, model: p.MODEL, hasKey: !!p.UPSTAGE_API_KEY };
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
  if (res.getResponseCode() !== 200) { console.warn('Upstage ' + res.getResponseCode()); return null; } // 내용은 기록하지 않음
  const data = JSON.parse(res.getContentText());
  return data.choices && data.choices[0] ? String(data.choices[0].message.content).trim() : null;
}

function clean_(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-10)
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
    .map(function (m) { return { role: m.role, content: m.content.slice(0, 300) }; });
}

function underLimit_(p) {
  const cache = CacheService.getScriptCache();
  const key = 'n_' + Math.floor(Date.now() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    const n = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(n), 120);
    return n <= Number(p.RATE_PER_MIN || 60);
  } finally { lock.releaseLock(); }
}

function props_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const out = {};
  Object.keys(DEFAULTS).forEach(function (k) { out[k] = all[k] || DEFAULTS[k]; });
  out.UPSTAGE_API_KEY = all.UPSTAGE_API_KEY || '';
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 처음 한 번 실행: 기본값 채우기 (키와 PIN은 직접 넣기) */
function setup() {
  const sp = PropertiesService.getScriptProperties();
  Object.keys(DEFAULTS).forEach(function (k) { if (!sp.getProperty(k)) sp.setProperty(k, DEFAULTS[k]); });
  if (!sp.getProperty('TEACHER_PIN')) console.log('스크립트 속성에 TEACHER_PIN을 넣어 주세요.');
  if (!sp.getProperty('UPSTAGE_API_KEY')) console.log('스크립트 속성에 UPSTAGE_API_KEY를 넣어 주세요.');
}

/** 연결 시험: 편집기에서 실행하면 로그에 답이 찍힌다 */
function testUpstage() {
  const p = props_();
  console.log(callUpstage_(p, [{ role: 'user', content: '안녕? 한 문장으로 답해 줘.' }], 0.3));
}
