// ==UserScript==
// @name         国开 AI 自动答题，仅支持国开平台的AI自动答题（Github：wsQvQ）
// @namespace    wsQ.ouchn.exam.ai.pure
// @version      1.7.19
// @description  国开 lms.ouchn.cn 纯全自动：AI 答题→自动填入（含匹配题/拖拽题、完形填空下拉）→全中交卷→成绩卡→让 AI 重新作答（仅供参考学习，严禁投入实际考试答题！诚信参考，后果自负！）
// @author       wsQvQ & 蓝色大肥鱼 🥰
// @match        https://lms.ouchn.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      *
// @noframes
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  /* 沙箱自检：加 @grant 后脚本进 Tampermonkey 沙箱，window 是代理，
     window.top === window 恒 false，必须拿 unsafeWindow 比较 */
  const UW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (UW.__ouchnAI || UW.__ouchnAF) return;   // 完整版在跑就让行，别双开打架
  let IS_TOP = false;
  try { IS_TOP = UW.top === UW; } catch (e) { IS_TOP = false; }
  if (!IS_TOP) return;
  UW.__ouchnAI = true;

  /* ==================== 配置 ==================== */
  const VER = '1.7.19';
  const CFG = {
    PREFIX: '蓝色大肥鱼提醒您：',
    STEP: 150,                 // 逐题填入间隔
    POLL: 120,
    LOCK_MS: 6000,             // 单步锁：只用来挡重复触发，不能长（长锁会把重载后的下一步挡死）
    MAX_TRIES: 3,
    FILL_WAIT: 20000,          // 等题目渲染上限
    OPT_STABLE: 2,
    SUBMIT_WAIT: 15000,
    SUBMIT_TRIES: 3,
    AI_TIMEOUT: 120000,        // 普通一轮 2 分钟
    AI_TIMEOUT_RETRY: 180000,  // 重答 3 分钟（给推理模型留思考时间）
    STALE_MS: 30 * 60 * 1000,
  };
  const API_DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
  const API_DEFAULT_MODEL = 'mimo-v2.6-flash';
  const KEY_MASK = '************';
  const STORE_ST = 'ouchn_ai_state_v1';
  const STORE_ANS = 'ouchn_ai_answers_v1';
  const STORE_REVIEW = 'ouchn_ai_review_v1';
  const STORE_AIPROC = 'ouchn_ai_aiproc_v1';
  const STORE_BATCH = 'ouchn_ai_batch_v1';
  const STORE_LOOSE = 'ouchn_ai_loose_v1';    // 上次 AI 回复原文：留给「按 AI 顺序先填上」按钮用
  const STORE_POS = 'ouchn_ai_pos_v1';        // 面板拖到哪就常驻在哪（以前每次重绘都弹回右下角）

  /* ==================== 工具 ==================== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && !!(el.getClientRects && el.getClientRects().length);
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 80);
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  const LOGS = [];
  function log(...a) {
    LOGS.push(new Date().toLocaleTimeString() + ' ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    if (LOGS.length > 200) LOGS.shift();
    console.log('[国开AI纯净版]', ...a);
  }

  /** 主文档 + 所有同源 iframe（递归 3 层：重考页有嵌套） */
  function allDocs() {
    const docs = [document];
    const walk = (d, depth) => {
      if (depth > 3) return;
      qa('iframe', d).forEach(f => {
        try {
          if (f.contentDocument && f.contentDocument.body) {
            docs.push(f.contentDocument);
            walk(f.contentDocument, depth + 1);
          }
        } catch (e) {}
      });
    };
    walk(document, 0);
    return docs;
  }
  function qAll(sel) {
    const out = [];
    allDocs().forEach(d => { try { out.push(...d.querySelectorAll(sel)); } catch (e) {} });
    return out;
  }
  function qAllFirst(sel) {
    const list = qAll(sel);
    return list.find(visible) || list[0] || null;
  }
  function findByText(re, sel) {
    return qAll(sel || 'span, a, div, button, li').find(el => visible(el) && re.test((el.textContent || '').trim())) || null;
  }

  async function waitFor(fn, timeout = 8000, interval = CFG.POLL) {
    const t0 = Date.now();
    for (;;) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      if (Date.now() - t0 > timeout) return null;
      await sleep(interval);
    }
  }

  /* ==================== 状态机（跨页面存续） ==================== */
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_ST) || 'null');
      if (!s) return { run: false, step: 'idle' };
      if (s.run && s.ts && Date.now() - s.ts > CFG.STALE_MS) return { run: false, step: 'idle' };
      return s;
    } catch (e) { return { run: false, step: 'idle' }; }
  }
  function saveState(s) { s.ts = Date.now(); try { localStorage.setItem(STORE_ST, JSON.stringify(s)); } catch (e) {} return s; }
  function patchState(o) { return saveState(Object.assign(loadState(), o)); }
  function advance(o) { return saveState(Object.assign(loadState(), o, { lockUntil: 0 })); }
  function resetState() { saveState({ run: false, step: 'idle', lockUntil: 0, tries: 0 }); }
  function lock(ms) { patchState({ lockUntil: Date.now() + (ms || CFG.LOCK_MS) }); }
  function isLocked() { const s = loadState(); return !!s.lockUntil && Date.now() < s.lockUntil; }
  function bumpTry() { const s = loadState(); s.tries = (s.tries || 0) + 1; return saveState(s).tries; }

  /* ==================== API 设置（Tampermonkey 私有存储，网页读不到密钥） ==================== */
  function loadAPI() {
    return {
      base:  String(GM_getValue('apiBase', '') || '').trim() || API_DEFAULT_BASE,
      key:   String(GM_getValue('apiKey', '') || '').trim(),
      model: String(GM_getValue('apiModel', '') || '').trim() || API_DEFAULT_MODEL,
    };
  }
  function saveAPI(o) {
    try {
      if ('apiBase'  in o) GM_setValue('apiBase', String(o.apiBase || '').trim());
      if ('apiKey'   in o && o.apiKey !== undefined) GM_setValue('apiKey', String(o.apiKey || '').trim());
      if ('apiModel' in o) GM_setValue('apiModel', String(o.apiModel || '').trim());
    } catch (e) { log('保存 API 配置失败：', String(e)); }
  }
  function apiEndpoint(base) {
    let b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (!/^https?:\/\//.test(b)) b = 'https://' + b;
    if (/^https?:\/\/[^/]+$/.test(b)) b += '/v1';
    return b;
  }
  function looseSubmitOn() { try { return !!GM_getValue('looseSubmit', false); } catch (e) { return false; } }

  /** 批量考试：队列存本机，跨页面存续 */
  function loadBatch() {
    try { return JSON.parse(localStorage.getItem(STORE_BATCH) || 'null') || { active: false, queue: [], idx: 0, results: [] }; }
    catch (e) { return { active: false, queue: [], idx: 0, results: [] }; }
  }
  function saveBatch(b) { try { localStorage.setItem(STORE_BATCH, JSON.stringify(b)); } catch (e) {} return b; }
  function batchRecord(title, msg) {
    const b = loadBatch();
    b.results.push({ title, msg });
    b.idx++;
    saveBatch(b);
    log('批量记录：', title, '→', msg);
  }

  /** 跨页面提示：写本机，下次 buildUI 时弹出（页面跳转不丢） */
  function setStickyNotice(msg, cls) {
    try { localStorage.setItem('ouchn_ai_notice_v1', JSON.stringify({ msg, cls: cls || 'bad', ts: Date.now() })); } catch (e) {}
  }

  /** 成绩不合格：3 秒红色倒计时即将重考，可紧急暂停（返回 false = 暂停） */
  function retryCountdown(title) {
    return new Promise(resolve => {
      if (!ui.res) return resolve(true);
      let n = 3, paused = false;
      const render = () => {
        ui.res.innerHTML = `<div class="countdown">${esc(title)}：成绩不合格，大肥鱼即将重新考试！<b>${n}</b></div>` +
          `<button class="danger" id="cdbg" style="width:100%;margin-top:8px">紧急暂停</button>`;
        ui.res.classList.add('on');
        const btn = ui.res.querySelector('#cdbg');
        if (btn) btn.addEventListener('click', () => { paused = true; });
      };
      render();
      const t = setInterval(() => {
        if (paused) { clearInterval(t); return resolve(false); }
        n--;
        if (n <= 0) { clearInterval(t); return resolve(true); }
        render();
      }, 1000);
    });
  }

  /* ==================== AI 调用（OpenAI 兼容，无状态单轮，无串流） ==================== */
  let CUR_REQ = null;
  function abortAI() {
    const had = !!CUR_REQ;
    try { if (CUR_REQ && CUR_REQ.abort) CUR_REQ.abort(); } catch (e) {}
    CUR_REQ = null;
    if (had) log('已终止 API 请求');
  }
  function callAI(prompt, cfgOverride, timeoutMs, opts) {
    const timeout = timeoutMs || CFG.AI_TIMEOUT;
    return new Promise(resolve => {
      const cfg = cfgOverride || loadAPI();
      if (!cfg.base || !cfg.key) return resolve({ ok: false, err: '未配置 API 接口或密钥，点右上角 ⚙ 设置' });
      const url = apiEndpoint(cfg.base) + '/chat/completions';
      const bodyOf = mt => JSON.stringify({
        model: cfg.model || API_DEFAULT_MODEL,
        messages: [{ role: 'user', content: prompt }],   // 只有一条 user：无历史上下文
        temperature: 0, max_tokens: mt, stream: false,
      });

      /** 发一次请求：cb(结果, meta)；meta.emptyContent/reasoning 用于「思考吃光额度」的自愈判断 */
      const fire = (maxTokens, cb) => {
      const t0 = Date.now();
      log('API 请求：', url, '| model =', cfg.model, '| max_tokens', maxTokens, '| 超时', Math.round(timeout / 1000) + 's');
      const done = fn => { CUR_REQ = null; fn(); };
      try {
        CUR_REQ = GM_xmlhttpRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
          data: bodyOf(maxTokens), timeout,
          onload: res => done(() => {
            const ms = Date.now() - t0;
            try {
              const j = JSON.parse(res.responseText);
              const ch = (j && j.choices && j.choices[0]) || {};
              const msg0 = ch.message || {};
              const content = msg0.content;
              const reasoning = msg0.reasoning_content || msg0.reasoning || '';
              const finish = ch.finish_reason || '';
              const looseOK = !!(opts && opts.loose) && res.status >= 200 && res.status < 300 && j && j.choices && j.choices.length > 0;
              if (res.status >= 200 && res.status < 300 && (content || looseOK)) {
                log('API 成功（', ms, 'ms）', finish ? '| finish_reason=' + finish : '');
                return cb({ ok: true, text: String(content || ''), reasoning: String(reasoning || ''), ms }, { finish, reasoning: String(reasoning || '') });
              }
              /* ★ 失败时把「服务端原话」带上：以前只说 HTTP 200，看不出到底是哪里不对 */
              const snippet = String(res.responseText || '').replace(/\s+/g, ' ').slice(0, 160);
              let msg = (j && j.error && j.error.message) || (j && j.message) || ('HTTP ' + res.status);
              if (res.status >= 200 && res.status < 300 && !content) {
                msg = reasoning
                  ? ('模型只输出了思考过程，没给最终答案（finish_reason=' + (finish || '?') + '，多半是 max_tokens 被思考用光）')
                  : ('响应里没有答案内容（finish_reason=' + (finish || '?') + '）：' + snippet);
              } else if (finish) { msg += '（finish_reason=' + finish + '）'; }
              log('API 异常：', msg);
              cb({ ok: false, err: msg, reasoning: String(reasoning || ''), raw: snippet },
                 { finish, emptyContent: !content, reasoning: String(reasoning || '') });
            } catch (e) {
              cb({ ok: false, err: '解析响应失败（HTTP ' + res.status + '）：' + String(res.responseText || '').replace(/\s+/g, ' ').slice(0, 160) });
            }
          }),
          onerror: e => done(() => { log('API 网络错误'); cb({ ok: false, err: '网络错误' + (e && e.error ? '：' + e.error : '') }); }),
          ontimeout: () => done(() => { log('API 超时'); cb({ ok: false, err: '请求超时（' + Math.round(timeout / 1000) + ' 秒）' }); }),
          /* ★ 急停时 GM_xmlhttpRequest 走的是 onabort：以前没这个回调 → Promise 永不 resolve →
               面板的「活着」计时器会一直空转、标签标题也还原不了 */
          onabort: () => done(() => { log('API 请求已被急停中止'); cb({ ok: false, err: '已中止' }); }),
        });
      } catch (e) { done(() => cb({ ok: false, err: String(e) })); }
      };

      /* ★ 自愈：推理模型（如小米 MiMo）有时把全部输出额度花在「思考」上，
         返回 200 但 content 为空 —— 以前直接报「AI 调用失败：HTTP 200」，看着像玄学。
         这里自动用 12288 token 重发一次；只对「要答案」的正式调用生效，测试连接的 maxTokens=8 不受影响。 */
      fire((opts && opts.maxTokens) || 4096, (r, meta) => {
        const canEscalate = !r.ok && meta && meta.emptyContent && meta.reasoning && !(opts && opts.maxTokens);
        if (!canEscalate) return resolve(r);
        /* ★ 推理模型「只思考不给答案」也是回炉的一种：只置个标记，让每秒刷新的面板自己切到橙色回炉样式
              （直接 setStatus 会被 1 秒后的刷新覆盖，这里统一交给 renderThink 渲染） */
        aiEscalated = true;
        log('自动重试一次：给 12288 token，避免思考过程挤掉最终答案');
        fire(12288, r2 => resolve(r2));
      });
    });
  }

  /** 洗 AI 回复：去代码围栏/客套行/加粗符号 */
  function cleanAIReply(raw) {
    let t = String(raw == null ? '' : raw);
    t = t.replace(/```[A-Za-z]*/g, '\n').replace(/```/g, '\n');
    const out = [];
    for (const l of t.split(/\r?\n/)) {
      const s = l.replace(/\*\*/g, '').trim();
      if (!s) continue;
      if (/^(以下是|以上就|上面就|答案如下|好的[，,。]|当然[，,。]|没问题|希望|如有|如果还有|注意[:：]|说明[:：]|备注[:：])/.test(s)) continue;
      out.push(s);
    }
    return out.join('\n');
  }

  /* ==================== 页面识别 ====================
   * ★ 答题页/结果页一律先认 URL，再看 DOM。
   *   旧版只看 .subject + .answer-options 就判「结果页」，但匹配题、完形填空这类新题型
   *   在【答题页】里就会渲染答案区（.answer-options / .subject-message），于是：
   *     detectPage() 返回 'grab' → 状态机不认页面 → 已经开考了还一直停在「正在进入考场」，
   *     而且点「AI 自动答题」也不会直接开跑（要白等 5 秒强制入场）。
   *   OUCHN 的答题页地址有两种形态：
   *     ① 经典形态 /exam/{id}/subjects#/take，结果页地址里带 /submission/
   *     ② 学习活动全屏模式 /course/{cid}/learning-activity/full-screen#/exam/{eid}
   *   URL 先圈范围，再用 DOM 细分，别再靠 class 猜。
   */
  function detectPage() {
    const url = location.href;
    const hash = location.hash || '';
    if (/\/submission\//.test(url)) return 'grab';                                    // 交卷后的结果页
    if (/\/exam\/\d+\/subjects/.test(url) && /#\/take/.test(url)) return 'fill';      // 答题页（经典形态 URL 铁证）
    /* ★ 学习活动全屏模式（用户实测的真实形态）：
     *   /course/{cid}/learning-activity/full-screen#/exam/{eid}   ← 再次考试的答题页
     *   /course/{cid}/learning-activity/full-screen#/            ← 形考任务列表
     *   答题页和「查看试卷/成绩」共用 #/exam/{eid} 这个路由，所以 URL 只能圈范围，靠 DOM 细分。 */
    if (/#\/exam\/\d+/.test(url)) {
      /* 这一步是【考试视图】：答题 / 查看试卷 / 成绩 可能共用同一个路由，只能靠证据分层判断
       *   ① 页面上有「可见且可用」的作答控件 → 一定是答题页（结果页的控件是 disabled 或不存在的）
       *   ② 没有作答控件、但有「开始答题/继续答题/返回测试」入口 → 当成入口页，交给进入流程去点
       *   ③ 既没控件也没入口，却有答案展示区 / 读到分数 → 结果页
       *   ④ 都没有 → 刚打开还没渲染，先当答题页 */
      const LIVE0 = 'input[type=radio]:not([disabled]), input[type=checkbox]:not([disabled]), ' +
                    '[contenteditable="true"], select.___select-answer, textarea, ' +
                    '.answer-pool .clone-area, .clone-area.drag-area, #cloneable-source .clone-area';
      const live0 = qAll(LIVE0).filter(visible).length;
      if (live0) return 'fill';
      if (findStartTrigger() || findReturnToExam()) return 'landing';
      const boxes0 = qAll('.subject .answer-options, .subject .subject-message, .answer-options, .subject-message').length;
      if (boxes0 || scanScore() !== '') return 'grab';                                // 只有答案/分数 → 结果页
      return 'fill';                                                                  // 考试视图刚打开、题目还没渲染
    }
    // 课程工作台（/course/{id}/ng#/…）：成绩列表会被误判成结果页
    if (/\/course\/\d+\/ng/.test(location.pathname || '') && !/\/exam\//.test(hash)) return 'course';

    const subjects = qAll('.subject');
    if (subjects.length) {
      // 兜底：有答案展示区，且整页没有任何「可交互作答控件」→ 结果页；否则是答题页
      const boxes = qAll('.subject .answer-options, .subject .subject-message').length;
      const live = qAll(
        '.subject input[type=radio]:not([disabled]), .subject input[type=checkbox]:not([disabled]), ' +
        '.subject [contenteditable="true"], .subject select.___select-answer, ' +
        '.subject .answer-pool .clone-area, .subject .clone-area.drag-area, .subject #cloneable-source .clone-area'
      ).length;
      if (boxes && !live) return 'grab';
      return 'fill';
    }
    if (qAll('[ng-click*="takeExam"]').length || qAll('input[name="confirm"]').length) return 'landing';
    if (findByText(/^(开始答题|继续答题|开始考试|再次答题|重新答题|再次考试|重新考试|再次作答|重新作答|继续考试|进入考试|开始作答|继续作答)$/, 'button, a, span')) return 'landing';
    if (/\/exam\//.test(hash)) return 'landing';
    return null;
  }

  /* ==================== 形考任务完成检测 ====================
   * 形考任务行：a.title[ng-bind="getActivityTitle(activity)"]（如「测试 | 形考任务1」），
   * 完成标记沿用上一版验证过的规则：行内存在 div.completeness.full = 已完成 */
  function scanActivities() {
    const titles = qAll('a.title[ng-bind*="getActivityTitle"], a.title.ng-binding');
    const seen = new Set();
    const out = [];
    titles.forEach(t => {
      const name = short(t.textContent, 60);
      if (!name || seen.has(name)) return;
      seen.add(name);
      const row = t.closest('.clickable-area') || t.closest('.learning-activity') || t.closest('li') || t.parentElement;
      const done = !!(row && q('.completeness.full', row)) || /已作答/.test(String((row && row.textContent) || '').slice(0, 300));
      out.push({ name, done, locked: /locked/.test(String(t.className || '')), target: row || t });
    });
    return out;
  }

  /* ==================== 题目识别 ==================== */
  function isRealQuestion(el) {
    if (!el) return false;
    if (qa('.option', el).length) return true;
    if (qa('.___answer', el).length) return true;
    if (qa('input[type=radio],input[type=checkbox]', el).length) return true;
    if (qa('.answer-options, .subject-message', el).length) return true;
    if (qa('.matching-answer-box, .answer-pool, [drag-type]', el).length) return true;   // 匹配题/拖拽题
    if (qa(CLOZE_SEL, el).length) return true;                                            // 完形填空/补全对话下拉
    if (qa('select', el).length && q('.subject-description', el)) return true;
    return false;
  }
  function questions() {
    const out = [];
    qAll('.subject').forEach(el => {
      const subs = el.classList.contains('analysis') ? qa('.sub-subject', el) : [];
      if (subs.length) subs.forEach(s2 => { if (isRealQuestion(s2)) out.push(s2); });
      else if (isRealQuestion(el)) out.push(el);
    });
    return out;
  }
  const labelOf   = o => (q('.option-index', o)?.textContent || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  const contentOf = o => (q('.option-content', o)?.textContent || '').trim();
  const inputOf   = o => q('input[type=radio],input[type=checkbox]', o);
  const noOf      = (sub, i) => ((q('.subject-resort-index .ng-binding', sub)?.textContent || '').trim()) || String(i + 1);
  const stemOf    = sub => short(q('.subject-description', sub)?.textContent || '');

  function findBlankEditors(sub) {
    let eds = qa('.___answer[contenteditable="true"]', sub);
    if (eds.length) return eds;
    eds = qa('.subject-description [contenteditable="true"]', sub);
    if (eds.length) return eds;
    return qa('[contenteditable="true"]', sub).filter(el => !el.closest('.option'));
  }
  function isWordBank(sub) {
    const stem = stemForAI(sub);
    if (!stem) return false;
    if (/[A-DＡ-Ｄ]\s*[）)⟩.．、]\s*\S/.test(stem)) return true;
    if (/答\s*[:：][\s\S]{0,40}?[A-DＡ-Ｄ]\s*[）)⟩.．、]/.test(stem)) return true;
    return false;
  }
  /** 题干：填空位替换为 [ ]，选项列表不混进题干 */
  function stemForAI(sub) {
    const el = q('.subject-description', sub);
    if (!el) return '';
    let txt;
    try {
      const doc = el.ownerDocument || document;
      const clone = el.cloneNode(true);
      qa('.___answer, [contenteditable="true"]', clone).forEach(v => {
        try { v.replaceWith(doc.createTextNode(' [ ] ')); } catch (e) { v.textContent = ' [ ] '; }
      });
      qa('ol,ul', clone).forEach(v => { if (qa('.option', v).length) v.remove(); });
      txt = clone.textContent || '';
    } catch (e) { txt = el.textContent || ''; }
    return txt.replace(/\s+/g, ' ').trim();
  }

  /** Angular 两段式渲染：等「题目数 + 选项数」稳定。
   *  ★ 不能只等 .option —— 纯匹配题/纯填空题一个 .option 都没有，
   *    旧逻辑会白等满 FILL_WAIT（20 秒），看起来就是「卡很久」 */
  async function waitOptionsStable(timeout) {
    const t0 = Date.now();
    let last = -1, stable = 0;
    for (;;) {
      const nq = questions().length;
      const n = nq > 0 ? nq * 100000 + qAll('.option').length : 0;
      if (n > 0 && n === last) { if (++stable >= CFG.OPT_STABLE) return n; }
      else { stable = 0; last = n; }
      if (Date.now() - t0 > timeout) return n;
      await sleep(300);
    }
  }

  /* ==================== 答案解析（AI 回复 → 逐题 token） ==================== */
  const ANS_NOISE = /(?:试题解析|答案解析|题目解析|参考解析|解析\s*[:：])/;
  const PURE_NUM_SEP = /^[\d\s,，、;；|/\\·.\-—_]*$/;

  function normalizeToken(raw) {
    const rawTrim = String(raw).trim();
    if (!rawTrim) return { empty: true };
    let s = rawTrim;
    s = s.replace(/(?:正确答案|参考答案|标准答案)\s*[:：]?/g, '');
    const noise = s.search(ANS_NOISE);
    if (noise >= 0) s = s.slice(0, noise);
    s = s.trim();
    if (!s) return { empty: true };
    s = s.replace(/^(?:第\s*)?\d+\s*题\s*[.．、)）:：]?\s*/, '');
    const stripped = s.replace(/^\d+\s*[.．)）:：]\s*/, '');
    if (stripped && !PURE_NUM_SEP.test(stripped)) s = stripped;
    if (!s) return { empty: true };
    if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(s)) return { empty: true };
    if (/[|｜]/.test(s)) return { mode: 'text', text: s, raw: rawTrim };
    if (/^[A-Za-z0-9\s,，、;；|/\\·.\-—_]+$/.test(s)) {
      const letters = [], digits = [];
      for (const ch of s) {
        if (/[A-Za-z]/.test(ch)) letters.push(ch.toUpperCase());
        else if (/[1-9]/.test(ch)) digits.push(String.fromCharCode(64 + Number(ch)));
      }
      const out = letters.length ? letters : digits;
      if (out.length) return { mode: 'letters', letters: out, raw: rawTrim };
    }
    return { mode: 'text', text: s, raw: rawTrim };
  }
  function parseAnswers(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.map(normalizeToken);
  }

  /* ==================== 按题号对齐（行数不符时的安全兜底） ====================
   * 事故：100 道题 AI 回了 103 行裸字母 → 行数对不上，只能整卷取消（其实答案全对，白瞎一次）。
   * 现在提示词要求每行带题号，于是可以：
   *   ① 题号齐全（1..N 各出现一次）→ 直接按题号落位，行数多几行少几行都不怕（多余题号忽略）；
   *   ② 题号有缺/有重 → 精确报告缺哪几号，并且只补这几题（小请求，成功率极高）；
   *   ③ 完全没题号 → 退回按行数对齐（原逻辑，行数不符才判错）。
   */
  /** 每行开头的题号 → {map, dup, out, covered, lines}；covered = 带【范围内】题号的非空行数
   *  超范围题号单独记 out（纯数字答案如 2020 不算覆盖，避免把填空题答案误当题号） */
  function numberMap(text, n) {
    const map = {}, dup = [], out = [];
    let lines = 0, covered = 0;
    String(text == null ? '' : text).replace(/\r/g, '').split('\n').forEach(line => {
      if (!line.trim()) return;
      lines++;
      /* 认这些写法：1. A ／ 2、B ／ 3）C ／ 4：D ／ 第5题 E ／ (6) F
         必须带分隔符或「题」字，且答案非空 —— 防止把纯数字填空答案（如 2020）误当题号 */
      const m = /^[\s(（]*(?:第\s*)?(\d{1,4})\s*(?:[.．、)）:：]|题)\s*(.+)$/.exec(line);
      if (!m) return;
      const no = Number(m[1]);
      if (!no) return;
      if (n && (no < 1 || no > n)) { out.push(no); return; }
      covered++;
      const tok = normalizeToken(m[2]);
      if (tok.empty) return;
      if (map[no] !== undefined) { dup.push(no); return; }
      map[no] = tok;
    });
    return { map: map, dup: dup, out: out, covered: covered, lines: lines };
  }
  /** 按题号对齐成 n 个 token（缺的位放 empty 占位，绝不挪位） */
  function alignByNumber(text, n) {
    const r = numberMap(text, n);
    const tokens = [], missing = [];
    for (let i = 1; i <= n; i++) {
      const t = r.map[i];
      if (t && !t.empty) tokens.push(t);
      else { tokens.push({ empty: true }); missing.push(i); }
    }
    return { tokens: tokens, missing: missing, dup: r.dup, out: r.out, coverage: r.lines ? r.covered / r.lines : 0, lines: r.lines };
  }
  /** 统一入口（安全优先）：
   *   · 行数正好 → 以行序为准（题号只是核对；纯数字答案如 3.5 不会被误当题号）
   *   · 行数不符 → 才启用题号对齐（这就是 100 题回 103 行那次能救回来的原因）
   *   · 题号覆盖率 <90% 且行数不符 → 位置不可信，判 mismatch（整卷取消，绝不猜） */
  function alignTokens(text, n) {
    const plain = parseAnswers(text);
    const a = alignByNumber(text, n);
    const numberedOK = a.coverage >= 0.9;
    if (numberedOK && plain.length !== n) {
      return { tokens: a.tokens, how: 'numbered', missing: a.missing, dup: a.dup, lines: a.lines };
    }
    if (plain.length === n) {
      if (numberedOK && !a.missing.length && !a.dup.length) {
        const same = a.tokens.every((t, i) => tokText(t) === tokText(plain[i]));
        if (same) return { tokens: a.tokens, how: 'numbered', missing: [], dup: [], lines: a.lines };
      }
      return { tokens: plain, how: 'positional', missing: [], dup: [], lines: plain.length };
    }
    return { tokens: plain, how: 'mismatch', missing: [], dup: [], lines: plain.length };
  }

  /* ==================== 宽松填入（按 AI 给的顺序硬填，剩下的手动；绝不自动交卷） ====================
   * 用户口径：分数不重要、只是走形式，所以「行数不对 / 有题填不上」时也允许先按顺序填上，
   * 剩下没填的自己选。安全性靠两点保证：① 这一路永远不会自动交卷；② 结果里明确写「可能错位」。
   */
  /** 纯函数：AI 回复 → n 个 token（够长就截断，不够就留空占位，位置绝不重排） */
  function looseTokens(text, n) {
    const al = alignTokens(text, n);
    const tk = al.tokens.slice(0, n);
    while (tk.length < n) tk.push({ empty: true });
    return { tokens: tk, how: al.how, missing: al.missing, lines: al.lines, extra: Math.max(0, al.lines - n) };
  }

  /** ★ 竖线风格的「纯字母多选」：A|B|C、A、B、A,B、A B → ['A','B','C']；不是这种就返回 null
   *  为什么需要：normalizeToken 把「带竖线的一律当文本」（那是给匹配题/多空填空用的），
   *  但 AI 写多选题常常写成 A|B|C → 被当文本 → pickText 按选项文字找 A|B|C → 一个都点不上。
   *  只有在「有选项的选择题」里才调用它，所以不会影响匹配题 / 填空题的竖线语义。 */
  function pipeLetters(s) {
    const t = String(s == null ? '' : s)
      .replace(/[\s｜|,，、;；/\\]+/g, '|').replace(/\|+/g, '|').replace(/^\||\|$/g, '');
    if (!t) return null;
    const segs = t.split('|');
    return segs.length > 1 && segs.every(x => /^[A-Za-z]$/.test(x)) ? segs.map(x => x.toUpperCase()) : null;
  }

  /* ==================== 填入（Angular 同步是难点） ==================== */
  function triggerAngularUpdate(el, value) {
    const ng = angularOf(el) || window.angular || (window.top && window.top.angular);
    if (!ng || !ng.element) return false;
    try {
      const $el = ng.element(el);
      const scope = $el.scope && $el.scope();
      const set = () => {
        const ctrl = $el.controller && $el.controller('ngModel');
        if (ctrl && ctrl.$setViewValue) {
          ctrl.$setViewValue(value);
          if (ctrl.$render) ctrl.$render();
        }
      };
      if (scope && scope.$apply) {
        try { scope.$apply(set); }
        catch (e) { if (scope.$evalAsync) scope.$evalAsync(set); }
      } else set();
      return true;
    } catch (e) { log('Angular 同步失败：', String(e)); return false; }
  }
  function fillEditable(el, text) {
    el.focus();
    try {
      const doc = el.ownerDocument || document;
      const sel = doc.getSelection ? doc.getSelection() : window.getSelection();
      if (sel) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      doc.execCommand('delete', false);
      doc.execCommand('insertText', false, text);
    } catch (e) {}
    if (!el.textContent || el.textContent.trim() !== String(text).trim()) el.textContent = text;
    ['input', 'change', 'blur', 'keyup', 'keydown', 'compositionend'].forEach(evt => {
      try { el.dispatchEvent(new Event(evt, { bubbles: true, cancelable: true })); } catch (e) {}
    });
    triggerAngularUpdate(el, text);
  }
  function splitBlanks(text) {
    return String(text).split(/\s*[|｜;；]\s*/).map(x => x.trim()).filter(Boolean);
  }
  function pickLetters(opts, want) {
    const need = [...want];
    const isMulti = opts.some(o => inputOf(o)?.type === 'checkbox');
    const r = { ok: true, picked: [], missed: [] };
    if (isMulti) {
      opts.forEach(o => {
        const inp = inputOf(o); if (!inp) return;
        const should = need.includes(labelOf(o));
        if (inp.checked !== should) inp.click();
        if (should) (inp.checked ? r.picked : r.missed).push(labelOf(o));
      });
    } else {
      const t = opts.find(o => labelOf(o) === need[0]);
      const inp = t && inputOf(t);
      if (!inp) return { ok: false, picked: [], missed: need };
      if (!inp.checked) inp.click();
      (inp.checked ? r.picked : r.missed).push(need[0]);
    }
    r.ok = r.missed.length === 0;
    return r;
  }
  function pickText(opts, text) {
    const t = opts.find(o => contentOf(o) === text) ||
              opts.find(o => contentOf(o) && (contentOf(o).includes(text) || text.includes(contentOf(o))));
    const inp = t && inputOf(t);
    if (!inp) return { ok: false, picked: [], missed: [text] };
    if (!inp.checked) inp.click();
    return { ok: inp.checked, picked: [labelOf(t)], missed: [] };
  }

  /* ==================== 匹配题（拖拽 / 配对） ====================
   * OUCHN 匹配题真实结构（已在 2.19.0 线上对照过一版，这里按同一套 DOM 写）：
   *   槽位行：.matching-answer-box > ul > li（行内有 [drag-type="to"] 和左侧题干 .list-panel）
   *   答案池：.answer-pool .clone-area.drag-area（id 形如 drag-node-12 或 data-option-id）
   *   平台模型：scope.subject.type === 'matching'
   *             subject.options[]        = 答案池（id / content）
   *             subject.sub_subjects[]   = 左侧每一项，写 note / answer_number / answeredOption = 选项 id
   *             保存回调 onChangeSubmission 在 $parent 链上
   * 写入顺序：① Angular 模型直写（走平台自己的保存链路）② 拖拽事件 ③ 坐标拖拽；
   *   每一种都要按槽位逐项核对（DOM 里真的落进去了才算成功）。
   */
  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
  const MATCH_ROW_SEL = '.matching-answer-box > ul > li';
  const MATCH_POOL_SEL = '.answer-pool .clone-area.drag-area, .answer-pool .clone-area, .match-item-right, .answer-pool-item, .drag-item';
  const MATCH_DRAG_TO = '[drag-type="to"]';

  /* >>> MATCH_PURE_START <<<（这段是纯函数，无 DOM 依赖；patch/match-plan.test.js 直接抠出来跑单测） */
  function normMatch(s) { return String(s == null ? '' : s).replace(/[\s\u00a0]+/g, '').toLowerCase(); }
  function poolLabelKey(v) {
    const s = String(v == null ? '' : v).trim().replace(/[.．、)）:：\s]/g, '');
    if (!s) return '';
    const ci = CIRCLED.indexOf(s[0]);
    if (s.length === 1 && ci >= 0) return '#' + (ci + 1);
    return s.toUpperCase();
  }
  /** 在一行答案里找答案池选项：先认字母/序号标签，再按选项文字匹配 */
  function findPoolMatch(raw, pool, used) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const unnumbered = s.replace(/^(?:第\s*)?\d+\s*[.．、)）:：\-—→>]\s*/, '').replace(/^[①-⑩]\s*/, '');
    const tag = unnumbered.match(/^([A-Za-z]|[①-⑩])\s*[.．、)）:：\-—→>]?\s*$/);
    if (tag) {
      const want = poolLabelKey(tag[1]);
      const hit = pool.find(p => poolLabelKey(p.label) === want) || pool.find(p => poolLabelKey(p.id) === want);
      if (hit) return hit;
    }
    const body = unnumbered.replace(/^[A-Za-z][.．、)）:：]\s*/, '');
    const tries = [s, unnumbered, body].map(normMatch).filter(Boolean);
    for (const t of tries) {
      const exact = pool.filter(p => normMatch(p.content) === t);
      if (exact.length) return exact.find(p => !used.has(p.label)) || exact[0];
      const part = pool.filter(p => { const c = normMatch(p.content); return !!c && (c.includes(t) || t.includes(c)); });
      if (part.length === 1) return part[0];
    }
    return null;
  }
  /** 答案段 → 逐槽位配对计划（段数必须等于槽位数，否则整体拒绝，防错位） */
  function planMatching(segs, pool, rowCount) {
    const list = (segs || []).map(x => String(x == null ? '' : x));
    if (list.length !== rowCount) return { ok: false, msg: `答案段数 ${list.length} ≠ 匹配槽位 ${rowCount}` };
    if (!pool || !pool.length) return { ok: false, msg: '没读到匹配题的答案池' };
    const used = new Set(), pairs = [];
    for (let i = 0; i < rowCount; i++) {
      const hit = findPoolMatch(list[i], pool, used);
      if (!hit) return { ok: false, msg: `第 ${i + 1} 项「${list[i].slice(0, 18)}」在答案池里找不到` };
      used.add(hit.label);
      pairs.push({ i, key: i + 1, raw: list[i], opt: hit });
    }
    return { ok: true, pairs };
  }
  /* >>> MATCH_PURE_END <<< */

  function matchLabel(i) { return i < 26 ? String.fromCharCode(65 + i) : '#' + (i + 1); }
  function matchOptionId(el) {
    if (!el) return '';
    const d = el.getAttribute && el.getAttribute('data-option-id');
    if (d) return String(d);
    const m = String((el.id) || '').match(/^drag-node-(\d+)$/);
    return m ? m[1] : '';
  }
  /** 面板文字：优先 .content-center（Vue 富文本容器），其次是直接文本节点 */
  function panelText(el) {
    if (!el) return '';
    const cc = q('.content-center', el) || el;
    let txt = '';
    try {
      txt = [...cc.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent || '').join(' ').trim();
    } catch (e) {}
    if (!txt) txt = (cc.firstElementChild ? cc.firstElementChild.textContent : cc.textContent) || '';
    return String(txt).replace(/\s+/g, ' ').trim();
  }
  function isMatchingQuestion(sub) {
    if (!sub) return false;
    if (q('.matching-answer-box', sub) || q('.answer-pool', sub) || q(MATCH_DRAG_TO, sub)) return true;
    const t = (q('.summary-sub-title', sub)?.textContent || '').trim();
    if (/匹配题|配对题/.test(t)) return true;
    return /(^|\s)(matching|match)(\s|$)/i.test(String(sub.className || ''));
  }
  /** 槽位行：严格选择器 → 宽松 → [drag-type="to"] 兜底 */
  function matchRows(sub) {
    const ok = row => row.querySelector(MATCH_DRAG_TO) && row.querySelector('.list-panel:not(.option):not(.panel-desc)');
    let rows = qa(MATCH_ROW_SEL, sub).filter(ok);
    if (rows.length) return rows;
    rows = qa('.matching-answer-box li', sub).filter(ok);
    if (rows.length) return rows;
    const seen = new Set(), out = [];
    qa(MATCH_DRAG_TO, sub).forEach(t => {
      const box = t.closest('li') || t.parentElement;
      if (box && !seen.has(box)) { seen.add(box); out.push(box); }
    });
    return out;
  }
  function matchingInfo(sub) {
    const rows = matchRows(sub);
    const items = rows.map((row, i) => {
      const sp = row.querySelector('.list-panel:not(.option):not(.panel-desc)');
      return { key: i + 1, stem: panelText(sp) };
    });
    const pool = [], seen = new Set();
    qa(MATCH_POOL_SEL, sub).forEach(el => {
      const content = panelText(el);
      const id = matchOptionId(el);
      const key = id || content;
      if (!content || seen.has(key)) return;
      seen.add(key);
      pool.push({ id, content, label: matchLabel(pool.length), el });
    });
    if (!pool.length) {   // DOM 池读不到时，回退读平台模型里的答案池
      const model = resolveMatchingSubject(scopeOf(sub));
      if (model && Array.isArray(model.options)) {
        model.options.forEach(o => {
          const content = String(o && o.content != null ? o.content : '');
          if (!content) return;
          pool.push({ id: String(o.id == null ? '' : o.id), content, label: matchLabel(pool.length), el: null });
        });
      }
    }
    return { rows, items, pool };
  }

  function winOf(el) {
    try { const w = el && el.ownerDocument && el.ownerDocument.defaultView; if (w) return w; } catch (e) {}
    return (typeof UW !== 'undefined' && UW) || window;
  }
  function angularOf(el) {
    const w = winOf(el);
    try { if (w && w.angular) return w.angular; } catch (e) {}
    try { if (UW && UW.angular) return UW.angular; } catch (e) {}
    return null;
  }
  function scopeOf(el) {
    const ng = angularOf(el);
    if (!ng || !ng.element) return null;
    try {
      const w = ng.element(el);
      return (w.scope && w.scope()) || (w.isolateScope && w.isolateScope()) || null;
    } catch (e) { return null; }
  }
  /** 在 scope 上找 type === 'matching' 的题目模型 */
  function resolveMatchingSubject(scope) {
    if (!scope) return null;
    const ok = v => v && typeof v === 'object' && v.type === 'matching' && Array.isArray(v.sub_subjects);
    try { if (ok(scope.subject)) return scope.subject; } catch (e) {}
    let keys = [];
    try { keys = Object.keys(scope); } catch (e) { return null; }
    for (const k of keys) {
      try { if (ok(scope[k])) return scope[k]; } catch (e) {}
    }
    return null;
  }
  /** ① 平台模型直写：改 note / answer_number / answeredOption，再通知 onChangeSubmission */
  function writeMatchingByScope(sub, pairs) {
    const scope = scopeOf(sub);
    const model = resolveMatchingSubject(scope);
    if (!scope || !model || !Array.isArray(model.sub_subjects) || !Array.isArray(model.options)) return false;
    if (model.sub_subjects.length !== pairs.length) return false;
    const writes = pairs.map(p => ({
      slot: model.sub_subjects[p.i],
      opt: model.options.find(o => p.opt.id && String(o.id) === String(p.opt.id)) ||
           model.options.find(o => normMatch(o.content) === normMatch(p.opt.content)),
    }));
    if (writes.some(w => !w.slot || !w.opt)) return false;
    let save = scope;
    for (let i = 0; i < 8 && save && typeof save.onChangeSubmission !== 'function'; i++) save = save.$parent;
    writes.forEach(w => {
      w.slot.note = w.opt;
      w.slot.answer_number = w.opt.id;
      w.slot.answeredOption = w.opt.id;     // 平台 collectAnswerData 读这个字段
    });
    try { if (scope.$apply) scope.$apply(); } catch (e) { try { if (scope.$evalAsync) scope.$evalAsync(); } catch (e2) {} }
    try {
      if (save && typeof save.onChangeSubmission === 'function') save.onChangeSubmission(model);
    } catch (e) { log('匹配题 onChangeSubmission 调用失败：', String(e)); }
    return true;
  }
  /** 逐槽位核对：DOM 里真的变成目标选项才算成功（不靠「派发过事件」蒙混）
   *  校验分两级：先按位置逐槽位比对，位置对不上（Angular 重排 / 兜底行选择器多命中）
   *  再降级为「集合一致」，最后再退一步允许「行文字包含该选项文字」 */
  async function verifyMatching(sub, pairs) {
    const tokenOf = (el, fallbackText) => {
      const clone = el && el.querySelector ? el.querySelector('.clone-area') : null;
      const id = matchOptionId(clone) || matchOptionId(el);
      if (id) return 'id:' + id;
      const txt = clone ? panelText(clone) : (panelText(el) || fallbackText);
      return 'tx:' + normMatch(txt);
    };
    const rowsNow = () => matchRows(sub).map(row => {
      const tgt = row.querySelector(MATCH_DRAG_TO) || row;
      return { tgt, token: tokenOf(tgt, row.textContent || '') };
    });
    const want = pairs.map(p => p.opt.id ? 'id:' + p.opt.id : 'tx:' + normMatch(p.opt.content));
    const check = () => {
      try {
        const rows = rowsNow();
        if (rows.length === pairs.length) {
          if (want.every((w, i) => rows[i].token === w)) return true;
          // 落后一级：行文字包含该选项文字
          if (pairs.every((p, i) => normMatch(p.opt.content) && normMatch(rows[i].tgt.textContent || '').includes(normMatch(p.opt.content)))) return true;
        }
        if (rows.length !== want.length) return false;
        const bag = rows.map(r => r.token);
        return want.every(w => {
          const k = bag.indexOf(w);
          if (k < 0) return false;
          bag.splice(k, 1);
          return true;
        });
      } catch (e) { return false; }
    };
    if (check()) return true;
    for (let i = 0; i < 5; i++) { await sleep(120); if (check()) return true; }
    return false;
  }
  function fireDrag(src, tgt) {
    const w = winOf(src);
    const seq = [[src, 'mousedown'], [src, 'dragstart'], [tgt, 'dragenter'], [tgt, 'dragover'], [tgt, 'drop'], [src, 'dragend'], [tgt, 'mouseup']];
    let dt = null;
    try { dt = new w.DataTransfer(); } catch (e) {}
    if (!dt) { try { dt = new (winOf(tgt).DataTransfer)(); } catch (e) {} }
    if (!dt) dt = { dropEffect: 'move', effectAllowed: 'move', types: [], files: [], items: [], setData() {}, getData() { return ''; } };
    seq.forEach(([el, type]) => {
      try {
        if (/^(drag|drop)/.test(type)) {
          let ev;
          try { ev = new w.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); }
          catch (e) {
            ev = new w.Event(type, { bubbles: true, cancelable: true });
            try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch (e2) {}
          }
          el.dispatchEvent(ev);
        } else {
          el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true }));
        }
      } catch (e) {}
    });
    return true;
  }
  const centerOf = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  /** ③ 真人式拖拽：拖拽合成事件对 jQuery 系拖拽通常无效，这条兜底发动鼠标轨迹 */
  async function humanDrag(src, tgt) {
    try {
      const w = winOf(src);
      const doc = src.ownerDocument;
      try { src.scrollIntoView({ block: 'center', inline: 'center' }); tgt.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      await sleep(100);
      const a = centerOf(src), b = centerOf(tgt);
      const pt = (el, type, x, y) => {
        const init = {
          bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y,
          button: 0, buttons: (type === 'mouseup' || type === 'pointerup') ? 0 : 1,
          pointerId: 1, pointerType: 'mouse', isPrimary: true,
        };
        try {
          if (/^pointer/.test(type) && typeof w.PointerEvent === 'function') el.dispatchEvent(new w.PointerEvent(type, init));
          else el.dispatchEvent(new w.MouseEvent(type, init));
        } catch (e) {}
      };
      pt(src, 'pointerdown', a.x, a.y); pt(src, 'mousedown', a.x, a.y);
      await sleep(80);
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const k = i / steps, x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
        const hover = (doc.elementFromPoint && doc.elementFromPoint(x, y)) || tgt;
        pt(hover, 'pointermove', x, y); pt(hover, 'mousemove', x, y);
        await sleep(16);
      }
      pt(tgt, 'pointerup', b.x, b.y); pt(tgt, 'mouseup', b.x, b.y); pt(tgt, 'click', b.x, b.y);
    } catch (e) { log('匹配题坐标拖拽失败：', String(e)); }
  }
  /** ② 平台模型复核：DOM 没回显时，看题目模型里的 answeredOption/note 是否已经是我们写的答案
   *  （平台 collectAnswerData 就是读这些字段，所以模型里的值也算落地证据） */
  function verifyMatchingModel(sub, pairs) {
    const model = resolveMatchingSubject(scopeOf(sub));
    if (!model || !Array.isArray(model.sub_subjects)) return false;
    if (model.sub_subjects.length !== pairs.length) return false;
    return pairs.every((p, i) => {
      const slot = model.sub_subjects[i];
      if (!slot) return false;
      const v = slot.answeredOption != null ? slot.answeredOption : slot.answer_number;
      if (v != null && String(v) !== '' && String(v) === String(p.opt.id)) return true;
      const note = slot.note;
      if (note && typeof note === 'object' && note.content != null && normMatch(note.content) === normMatch(p.opt.content)) return true;
      return false;
    });
  }
  async function dragMatchingPass(sub, pairs, human) {
    for (const p of pairs) {
      const rows = matchRows(sub);
      const row = rows[p.i];
      if (!row) return false;
      const tgt = row.querySelector(MATCH_DRAG_TO) || row;
      const clone = tgt.querySelector('.clone-area');
      const placedId = matchOptionId(clone) || matchOptionId(tgt);
      // 这个槽位已经是目标选项（上一轮已经拖进去了）→ 跳过，别再把池里找不到的源当失败
      if (placedId && p.opt.id && String(placedId) === String(p.opt.id)) continue;
      if (!placedId && normMatch(panelText(clone || tgt)).includes(normMatch(p.opt.content)) && normMatch(p.opt.content)) continue;
      const srcs = qa(MATCH_POOL_SEL, sub);
      const cands = srcs.filter(el => {
        const id = matchOptionId(el);
        if (id && p.opt.id) return String(id) === String(p.opt.id);
        return normMatch(panelText(el)) === normMatch(p.opt.content);
      });
      if (!cands.length) return false;
      if (human) await humanDrag(cands[0], tgt); else fireDrag(cands[0], tgt);
      await sleep(human ? 200 : 120);
    }
    return true;
  }
  /** 匹配题总入口：返回 { ok, msg, pairs } */
  async function fillMatching(sub, tok, info) {
    if (!info.rows.length) return { ok: false, msg: '没找到匹配题槽位（.matching-answer-box / [drag-type="to"]）', pairs: [] };
    let segs;
    if (tok && tok.mode === 'letters' && tok.letters.length === info.rows.length) segs = tok.letters.slice();
    else segs = splitBlanks(tok && tok.mode === 'letters' ? tok.raw : (tok ? tok.text : ''));
    const plan = planMatching(segs, info.pool, info.rows.length);
    if (!plan.ok) return { ok: false, msg: plan.msg, pairs: [] };
    let how = '';
    if (writeMatchingByScope(sub, plan.pairs)) {
      if (await verifyMatching(sub, plan.pairs)) how = '模型写入';
      else if (verifyMatchingModel(sub, plan.pairs)) how = '模型写入（页面未回显，交卷前建议看一眼）';
    }
    if (!how) {
      await dragMatchingPass(sub, plan.pairs, false);
      if (await verifyMatching(sub, plan.pairs)) how = '拖拽事件';
    }
    if (!how) {
      await dragMatchingPass(sub, plan.pairs, true);
      if (await verifyMatching(sub, plan.pairs)) how = '坐标拖拽';
    }
    if (!how) {
      return { ok: false, msg: `模型写入/拖拽事件/坐标拖拽都试过，页面没接受（槽位 ${info.rows.length} · 答案池 ${info.pool.length}）`, pairs: plan.pairs };
    }
    return { ok: true, msg: how, pairs: plan.pairs };
  }

  /* ==================== 完形填空 / 补全对话（题干内嵌下拉空位） ====================
   * OUCHN 这种题不是 .option，也不是 contenteditable，而是题干里塞了隐藏 select：
   *   select.___select-answer 或 select[multi-select][ng-model*="answeredOption"]
   * 页面用 jQuery multiselect 插件把它渲染成按钮 + 单选框菜单，光改 select.value 会被插件改回去，
   * 所以必须三套状态一起推：原生 select.value / jQuery(multiselect) / Angular ngModel，然后读回校验。
   */
  const CLOZE_SEL = 'select.___select-answer, select[multi-select][ng-model*="answeredOption"]';
  function clozeSelects(sub) { return qa(CLOZE_SEL, sub).filter(el => el.tagName === 'SELECT'); }
  /** 题干上方那段「A. 数据  B. 信息 …」的地方就是每个下拉字母对应的词 */
  function clozeWordMap(sub) {
    const map = new Map();
    let prev = (sub.closest && sub.closest('.subject')) || sub;
    prev = prev.previousElementSibling;
    for (let step = 0; prev && step < 4; step++, prev = prev.previousElementSibling) {
      const txt = String(prev.textContent || '').replace(/\s+/g, ' ');
      const re = /(?:^|\s)([A-Z])\s*[.、．]\s*([\s\S]*?)(?=\s+[A-Z]\s*[.、．]\s*|$)/g;
      let m;
      while ((m = re.exec(txt)) !== null) map.set(m[1].toUpperCase(), String(m[2]).trim());
      if (map.size) break;
    }
    return map;
  }
  function clozeOptions(sub) {
    const sel = clozeSelects(sub)[0];
    if (!sel) return [];
    const words = clozeWordMap(sub);
    return [...sel.options].filter(o => !o.disabled && o.value).map(o => {
      const label = String(o.textContent || o.label || '').replace(/\s+/g, ' ').trim();
      return { label, content: words.get(clozeLabel(label)) || label, value: o.value };
    });
  }

  /* >>> CLOZE_PURE_START <<<（纯函数：答案段 → 目标 option.value） */
  function clozeLabel(v) { return String(v == null ? '' : v).replace(/[\s\u00a0.、．]/g, '').toUpperCase(); }
  function resolveClozeTargets(segs, opts) {
    const out = [];
    for (const raw of segs) {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) { out.push(''); continue; }
      const bare = s.replace(/^(?:第\s*)?\d+\s*[.．、)）:：\-—→>]\s*/, '');
      const byLabel = opts.find(o => clozeLabel(o.label) === clozeLabel(bare)) ||
                      opts.find(o => clozeLabel(o.value) === clozeLabel(bare));
      if (byLabel) { out.push(byLabel.value); continue; }
      const n = normMatch(bare);
      const hit = opts.find(o => normMatch(o.content) === n) ||
                  opts.filter(o => { const c = normMatch(o.content); return !!c && (c.includes(n) || n.includes(c)); });
      out.push(Array.isArray(hit) ? (hit.length === 1 ? hit[0].value : '') : (hit ? hit.value : ''));
    }
    return out;
  }
  /** 从 select 的 ng-model 里抠出它对应第几个空（定位 Angular 模型里的空位） */
  function clozeBlankIndex(ngModel) {
    const m = /sub_subjects\s*\[\s*(\d+)\s*\]/.exec(String(ngModel == null ? '' : ngModel));
    return m ? Number(m[1]) : -1;
  }
  /* >>> CLOZE_PURE_END <<< */

  function clozeSetValue(sel, opt) {
    [...sel.options].forEach(o => { o.selected = o === opt; });
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(sel, opt.value);
      else sel.value = opt.value;
    } catch (e) { try { sel.value = opt.value; } catch (e2) {} }
  }
  function clozeFireChange(sel) {
    ['input', 'change'].forEach(t => { try { sel.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
    try {
      const w = winOf(sel);
      const jq = w && (w.jQuery || w.$);
      if (jq) jq(sel).trigger('change');
    } catch (e) {}
  }
  function clozeMultiselectRadio(sel, opt) {
    const root = sel.closest('.subject') || sel.ownerDocument;
    const name = 'multiselect_' + sel.id;
    return [...root.querySelectorAll('input[type=radio]')].find(r => r.name === name && r.value === opt.value) || null;
  }
  function clozePushMultiselect(sel, opt) {
    try {
      const radio = clozeMultiselectRadio(sel, opt);
      const btn = sel.id && sel.ownerDocument.getElementById(sel.id + '_ms');
      const span = btn && btn.querySelector('span:last-child');
      if (span) span.textContent = (opt.textContent || opt.label || '').trim();
      if (btn) btn.classList.remove('gray');
      if (!radio) return !!span;
      (radio.closest('label') || radio).click();
      radio.checked = true;
      radio.setAttribute('checked', 'checked');
      radio.closest('label') && radio.closest('label').classList.add('ui-state-active');
      const menu = radio.closest('.ui-multiselect-menu');
      if (menu) menu.querySelectorAll('input[type=radio]').forEach(other => {
        if (other === radio || other.name !== radio.name) return;
        other.checked = false;
        other.removeAttribute('checked');
        other.closest('label') && other.closest('label').classList.remove('ui-state-active');
      });
      return true;
    } catch (e) { return false; }
  }
  function clozeVerify(sel, opt) {
    try {
      if (sel.value !== opt.value) return false;
      const radio = clozeMultiselectRadio(sel, opt);
      if (radio && !radio.checked) return false;
      return true;
    } catch (e) { return false; }
  }
  /* ==================== ★ 完形填空：直写 Angular 模型 ====================
   *  2026-10 实测（真实考试页）：
   *   ① 平台的 select 由 ng-options 渲染，option 的 value 是占位串「? object:850 ?」
   *      → 写 select.value = 选项ID 根本不可能命中（这就是「仅 1/10 个下拉写入成功」的第一个原因）；
   *   ② 真正生效的是 Angular 模型：sub_subjects[i].answeredOption = 【选项 id 的字符串】+ 调登记钩子 + $apply
   *      → 实测写进去 2 秒后仍在 ✓；写对象会被后端判「提交数据格式异常」✗（见下面 clozeWriteModel 注释）
   *      → 实测写进去 2 秒后仍在 ✓；
   *   ③ 而派发 change/input 会让 Angular 反过来读那个占位串，把刚写进去的答案冲成空
   *      → 这是「仅 1/10」的真凶，所以这条路【绝不派发 change】；
   *   ④ 插件按钮文字只需手动同步外观，【不能点 radio】（点了会触发插件自己的 change 回写，同样冲掉答案）。
   */
  function clozeModelCtx(sel) {
    try {
      const w = winOf(sel);
      const ng = w && w.angular;
      if (!ng) return null;
      let sc = ng.element(sel).scope();
      while (sc && !(sc.subject && Array.isArray(sc.subject.sub_subjects))) sc = sc.$parent;
      const subj = sc && sc.subject;
      const idx = clozeBlankIndex(sel.getAttribute('ng-model'));
      if (!subj || idx < 0 || !subj.sub_subjects[idx]) return null;
      return { sc: sc, subj: subj, idx: idx, blank: subj.sub_subjects[idx] };
    } catch (e) { return null; }
  }
  /** 只写模型 + 调平台登记钩子 + $apply（绝不派发 change）
   *  ★★ 平台要的值是【选项 id 的字符串】，不是选项对象！
   *     实测对照（真实考试页）：用户手动点一下下拉 → 平台存的是 answeredOption: "40073940314"（string）；
   *     写对象则会让 Angular 的 select 里多出一个「? object:850 ?」占位选项（=模型值它不认识），
   *     前端 !!answeredOption 仍判为已答（进度会动），但后端保存/交卷直接报「提交数据格式异常」。
   *  ★ 还必须调平台登记钩子（select 上写着 ng-change="onChangeSubmission(subject.sub_subjects[N])"）：
   *    不调它，这个空的作答状态平台不认（实测整题答题进度不动）。 */
  function clozeWriteModel(sel, opt) {
    const ctx = clozeModelCtx(sel);
    if (!ctx) return false;
    const id = Number(opt.value);
    const optObj = (ctx.blank.options || []).find(o => Number(o.id) === id) ||
                   (ctx.subj.options || []).find(o => Number(o.id) === id);
    if (!optObj) return false;
    ctx.blank.answeredOption = String(optObj.id);
    try {
      const hook = (typeof ctx.sc.onChangeSubmission === 'function') ? ctx.sc.onChangeSubmission
                 : (ctx.sc.$parent && typeof ctx.sc.$parent.onChangeSubmission === 'function') ? ctx.sc.$parent.onChangeSubmission : null;
      if (hook) hook(ctx.blank);
    } catch (e) {}
    try { ctx.sc.$apply(); } catch (e) {
      try { ctx.sc.$digest(); } catch (e2) { return false; }
    }
    return true;
  }
  /** 校验只读模型（DOM 那层是假象），并按平台口径比较：字符串 id */
  function clozeVerifyModel(sel, opt) {
    const ctx = clozeModelCtx(sel);
    if (!ctx) return false;
    const cur = ctx.blank.answeredOption;
    if (cur == null || cur === '') return false;
    const id = Number(opt.value);
    const want = (ctx.blank.options || []).find(o => Number(o.id) === id) ||
                 (ctx.subj.options || []).find(o => Number(o.id) === id);
    return String(cur) === String(want ? want.id : opt.value);
  }
  /** 只同步插件外观（按钮文字 + 单选状态），不触发任何 change */
  function clozePaintWidget(sel, opt) {
    try {
      const radio = clozeMultiselectRadio(sel, opt);
      if (radio) {
        radio.checked = true; radio.setAttribute('checked', 'checked');
        const lab = radio.closest('label');
        if (lab) lab.classList.add('ui-state-active');
        const menu = radio.closest('.ui-multiselect-menu');
        if (menu) menu.querySelectorAll('input[type=radio]').forEach(o => {
          if (o === radio || o.name !== radio.name) return;
          o.checked = false; o.removeAttribute('checked');
          const l2 = o.closest('label');
          if (l2) l2.classList.remove('ui-state-active');
        });
      }
      const btn = sel.id && sel.ownerDocument.getElementById(sel.id + '_ms');
      const span = btn && btn.querySelector('span:last-child');
      if (span) span.textContent = String(opt.textContent || opt.label || '').trim();
      if (btn) btn.classList.remove('gray');
      return true;
    } catch (e) { return false; }
  }
  async function fillClozeOne(sel, opt) {
    /* ① 首选：直写 Angular 模型（实测唯一能让平台认下的路；这条不派发任何 change） */
    if (clozeWriteModel(sel, opt)) {
      clozePaintWidget(sel, opt);
      for (const d of [100, 220]) { await sleep(d); if (clozeVerifyModel(sel, opt)) return true; }
    }
    /* ② 兜底：老路（写 DOM + 事件 + 插件 UI）。平台别种下拉（option value 是真 ID）仍然有效 */
    clozeSetValue(sel, opt); clozeFireChange(sel); triggerAngularUpdate(sel, opt.value); clozePushMultiselect(sel, opt);
    // 插件自己的 change 回调会把 select.value 改回去，所以必须二轮写
    clozeSetValue(sel, opt); clozeFireChange(sel); triggerAngularUpdate(sel, opt.value);
    for (const d of [80, 150]) { await sleep(d); if (clozeVerify(sel, opt) || clozeVerifyModel(sel, opt)) return true; }
    return false;
  }
  /** 完形填空总入口：返回 { ok, msg, targets } */
  async function fillCloze(sub, tok) {
    const selects = clozeSelects(sub);
    if (!selects.length) return { ok: false, msg: '没找到下拉空位' };
    const opts = clozeOptions(sub);
    const segs = (tok && tok.mode === 'letters' && tok.letters.length === selects.length)
      ? tok.letters.slice()
      : splitBlanks(tok && tok.mode === 'letters' ? tok.raw : (tok ? tok.text : ''));
    if (segs.length !== selects.length) return { ok: false, msg: `答案段数 ${segs.length} ≠ 下拉空位 ${selects.length}` };
    const targets = resolveClozeTargets(segs, opts);
    const labels = targets.map(t => { const o = opts.find(x => x.value === t); return o ? clozeLabel(o.label) : ''; });
    const missIdx = targets.map((t, k) => (t ? -1 : k)).filter(k => k >= 0);
    if (missIdx.length) return { ok: false, msg: '有答案在选项里找不到：' + missIdx.map(k => `第${k + 1}项「${short(segs[k], 14)}」`).join('、'), labels };
    let okN = 0;
    for (let k = 0; k < selects.length; k++) {
      const opt = [...selects[k].options].find(o => o.value === targets[k]);
      if (!opt) continue;
      if (await fillClozeOne(selects[k], opt)) okN++;
      await sleep(80);
    }
    return okN === selects.length
      ? { ok: true, msg: '下拉全部写入', labels }
      : { ok: false, msg: `仅 ${okN}/${selects.length} 个下拉写入成功（已按 Angular 模型校验，不看页面显示）`, labels };
  }

  /** 逐题填入；返回报告 */
  async function fillAnswers(tokens, onProgress) {
    const qs = questions();
    const report = [];
    for (let i = 0; i < qs.length; i++) {
      const qEl = qs[i], tok = tokens[i] || { empty: true };
      const opts = qa('.option', qEl);
      const disp = tok.empty ? '(空)' : (tok.mode === 'letters' ? tok.letters.join('') : tok.text);
      const base = { no: noOf(qEl, i), type: '—', tok: disp, res: '' };

      // 匹配题（拖拽/配对）：模型写入 → 拖拽事件 → 坐标拖拽，逐槽位校验，验不过不许算成功
      if (isMatchingQuestion(qEl)) {
        base.type = '匹配题';
        base.tok = short(disp, 60);
        if (tok.empty) {
          base.res = '跳过（AI 没给答案）';
          report.push(base); onProgress?.(i + 1, qs.length); await sleep(CFG.STEP);
          continue;
        }
        const info = matchingInfo(qEl);
        log('匹配题：槽位', info.rows.length, '· 答案池', info.pool.length, '· 池标签', info.pool.map(p => p.label).join(''));
        const r = await fillMatching(qEl, tok, info);
        if (r.ok) base.tok = r.pairs.map(p => p.opt.label).join('|');
        base.res = r.ok ? `✅ ${base.tok}（${r.msg}）` : `❌ ${r.msg}`;
        log('匹配题填入：', r.ok ? '成功（' + r.msg + '）' : '失败：' + r.msg);
        report.push(base); onProgress?.(i + 1, qs.length); await sleep(CFG.STEP);
        continue;
      }

      // 完形填空/补全对话：题干里内嵌的下拉空位（不是 .option，也不是 contenteditable）
      if (!opts.length && clozeSelects(qEl).length) {
        base.type = '完形填空';
        base.tok = short(disp, 60);
        if (tok.empty) {
          base.res = '跳过（AI 没给答案）';
          report.push(base); onProgress?.(i + 1, qs.length); await sleep(CFG.STEP);
          continue;
        }
        const r = await fillCloze(qEl, tok);
        if (r.ok && r.labels) base.tok = r.labels.join('|');
        base.res = r.ok ? `✅ ${base.tok}（${r.msg}）` : `❌ ${r.msg}`;
        log('完形填空填入：', r.ok ? '成功' : r.msg);
        report.push(base); onProgress?.(i + 1, qs.length); await sleep(CFG.STEP);
        continue;
      }

      if (!opts.length) {
        const blanks = findBlankEditors(qEl);
        if (!blanks.length) {
          base.type = '其他';
          base.res = tok.empty ? '跳过' : '非选择题，需手填';
          report.push(base); onProgress?.(i + 1, qs.length); continue;
        }
        base.type = blanks.length > 1 ? `填空×${blanks.length}` : '填空';
        if (tok.empty) { base.res = '跳过'; report.push(base); onProgress?.(i + 1, qs.length); continue; }
        const parts = splitBlanks(tok.mode === 'letters' ? tok.raw : tok.text);
        const vals = (blanks.length === 1 && parts.length > 1) ? [parts.join(' ')] : parts;
        if (vals.length !== blanks.length) {
          base.res = `⚠ 空位数(${blanks.length}) 与答案段数(${vals.length}) 不符`;
          report.push(base); onProgress?.(i + 1, qs.length); continue;
        }
        let okB = 0;
        for (let k = 0; k < blanks.length; k++) {
          fillEditable(blanks[k], vals[k]);
          await sleep(120);
          if ((blanks[k].textContent || '').trim() === vals[k]) okB++;
        }
        base.res = okB === blanks.length ? '✅ ' + vals.join(' | ') : `❌ 仅 ${okB}/${blanks.length} 空写入成功`;
        report.push(base); onProgress?.(i + 1, qs.length);
        await sleep(CFG.STEP);
        continue;
      }
      if (tok.empty) { base.res = '跳过'; report.push(base); onProgress?.(i + 1, qs.length); continue; }

      const isMulti = opts.some(o => inputOf(o)?.type === 'checkbox');
      base.type = isMulti ? '多选' : '单选';
      /* ★ 有选项的题：A|B|C 这种「纯字母竖线」一定是多选答案（分词器把带竖线的都判成文本了，
           那是给匹配题/多空填空用的）——这里按题目类型兜底纠正，否则一个选项都点不上 */
      let tk = tok;
      if (tok.mode === 'text') {
        const ls = pipeLetters(tok.text);
        if (ls) {
          tk = { mode: 'letters', letters: ls, raw: tok.raw };
          base.tok = ls.join('');
          log('多选题：竖线答案按字母解析 →', ls.join(''));
        }
      }
      let r;
      if (tk.mode === 'letters' && !isMulti && tk.letters.length > 1) {
        base.res = '❌ 单选却给了 ' + tk.letters.join('') + '，已跳过防错位';
        report.push(base); onProgress?.(i + 1, qs.length); await sleep(CFG.STEP); continue;
      }
      if (tk.mode === 'letters') {
        r = pickLetters(opts, tk.letters);
        if (!r.ok) { const t = pickText(opts, tk.raw); if (t.ok) r = t; }
      } else {
        r = pickText(opts, tk.text);
      }
      base.res = r.ok ? '✅ ' + r.picked.join('') : '❌ 未命中 ' + r.missed.join('');
      report.push(base); onProgress?.(i + 1, qs.length);
      await sleep(CFG.STEP);
    }
    return { total: qs.length, report };
  }

  /* ==================== 提示词 ==================== */
  function buildAskPrompt(prefixLines) {
    const qs = questions();
    if (!qs.length) return '';
    const blocks = qs.map((sub, i) => {
      const stem = stemForAI(sub);
      if (isMatchingQuestion(sub)) {
        const info = matchingInfo(sub);
        const n = info.items.length || info.rows.length;
        const left = info.items.map(it => `${it.key}. ${short(it.stem, 70)}`).join(' ｜ ');
        const poolTxt = info.pool.map(p => `${p.label}: ${short(p.content, 70)}`).join(' ｜ ');
        const demo = n > 0
          ? Array.from({ length: n }, (_, k) => (info.pool[k] ? info.pool[k].label : 'A')).join('|')
          : 'B|A|C';
        return `${i + 1}. ${stem}\n【匹配题】左侧 ${n} 项（按 1→${n} 的顺序），答案池 ${info.pool.length} 个选项。\n请为左侧每一项从答案池中选一个选项，只输出【答案池的选项字母】，用 | 分隔，共 ${n} 段。\n左侧项：${left}\n答案池：${poolTxt}\n例：${demo}`;
      }
      const optEls = qa('.option', sub);
      if (optEls.length) {
        return `${i + 1}. ${stem}\n${optEls.map(o => `${labelOf(o)}. ${contentOf(o)}`).join('\n')}`;
      }
      const cloze = clozeSelects(sub);
      if (!optEls.length && cloze.length) {
        const cOpts = clozeOptions(sub);
        const list = cOpts.map(o => `${o.label}${o.content && o.content !== o.label ? '=' + short(o.content, 24) : ''}`).join(' ｜ ');
        const demo = Array.from({ length: cloze.length }, (_, k) => (cOpts[k] ? clozeLabel(cOpts[k].label) : 'A')).join('|');
        return `${i + 1}. ${stem}\n【完形填空/补全对话】共 ${cloze.length} 个下拉空位，按空位顺序输出所选【选项字母】，用 | 分隔，共 ${cloze.length} 段。\n可选：${list}\n例：${demo}`;
      }
      const nb = findBlankEditors(sub).length;
      let tip;
      if (!nb) tip = '（本题无选项）';
      else if (isWordBank(sub)) tip = `【选词填空】共 ${nb} 个空，请按空位顺序输出【选项字母】，用 | 分隔。例：D|C|B|A`;
      else tip = `【纯填空】共 ${nb} 个空，请按空位顺序输出【应填的文字】，用 | 分隔`;
      return `${i + 1}. ${stem}\n${tip}`;
    });
    return [
      '你是答题助手。下面是一份试卷（共 ' + qs.length + ' 道题），请只输出每道题的正确答案。',
      '',
      '输出要求（严格遵守，不要有任何多余内容）：',
      '0. ★ 本卷共 ' + qs.length + ' 道题，你必须输出【恰好 ' + qs.length + ' 行】：一题一行、顺序一致。多一行或少一行都会被判为错误并整卷打回重做。',
      '1. ★ 每行必须以【题号 + 点 + 空格】开头，题号就是下面试卷里的题号，例如：1. A   2. B   3. 中央处理器',
      '   题号必须与试卷一一对应：不能跳号、不能重复、不能出现试卷以外的题号。',
      '2. 题号后面只写答案，不要写题目文字或选项文字，不要写解释、分析或任何多余字符',
      '3. 不要写解释、分析或任何多余字符',
      '4. 单选题 → 一个字母（如 A）；多选题 → 字母直接连写、不要用竖线（如 ABD，别写成 A|B|D）',
      '5. 判断题 → 正确 A，错误 B',
      '6. [ ] 表示填空位。多空按从前到后顺序，一律用竖线 | 分隔',
      '7. 【纯填空】输出应填的【文字】，例：中央处理器   或   运算器|控制器',
      '8. 【选词填空】输出【选项字母】，例：D|C|B|A，不要填候选词本身',
      '9. 填空题不要加「答：」「答案：」「是」等前缀，不要带标点',
      '10. 简答题输出简短要点即可',
      '11. 匹配题 → 按左侧 1→N 的顺序，输出答案池的【选项字母】，用竖线 | 分隔，如 B|A|C',
      '12. 【完形填空/补全对话】→ 按空位顺序输出下拉的【选项字母】，用竖线 | 分隔',
      '',
      '示例输出（严格照这个格式：行首是题号，一行一题）：',
      '1. A',
      '2. B',
      '3. ACD',
      '4. 中央处理器',
      '5. 运算器|控制器',
      '6. D|C|B|A',
      '7. B|A|C',
      '',
      ...(prefixLines || []),
      '===== 试卷 =====',
      ...blocks,
    ].join('\n');
  }

  /** 把 token（对象）或裸字符串统一成可判断的文本 —— 注意 token 是对象，String(obj) 会变 [object Object] */
  function tokText(t) {
    if (t == null) return '';
    if (typeof t === 'string') return t.trim();
    if (t.empty) return '';
    if (t.mode === 'letters') return (t.letters || []).join('');
    return String(t.text || t.raw || '').trim();
  }
  /** 行数不符时的「形状对照」：本卷需要什么形状、AI 给了什么形状 —— 一眼看出多在哪 */
  function shapeReport(tokens, qs) {
    const shapeOf = t => {
      const s = tokText(t);
      if (!s) return '空行';
      if (s.indexOf('|') >= 0) return '竖线行';
      if (/^[A-Za-z]{1,10}$/.test(s)) return '字母行';
      return '文本行';
    };
    const need = { 字母行: 0, 竖线行: 0, 文本行: 0 };
    (qs || []).forEach(sub => {
      if (isMatchingQuestion(sub) || clozeSelects(sub).length) need['竖线行']++;
      else if (qa('.option', sub).length) need['字母行']++;
      else need['文本行']++;
    });
    const got = { 字母行: 0, 竖线行: 0, 文本行: 0, 空行: 0 };
    (tokens || []).forEach(t => got[shapeOf(t)]++);
    const f = o => Object.keys(o).filter(k => o[k]).map(k => k + ' ' + o[k]).join('、') || '（无）';
    return '本卷需要：' + f(need) + '；AI 给了：' + f(got);
  }

  /** 行数不符/缺题号时的回炉提示词：把精确诊断 + 上次回复一并给它自查（题目照旧再发一遍） */
  function buildFixPrompt(prevText, n, diag) {
    const lines = String(prevText || '').replace(/\r/g, '').split('\n').filter(t => t.trim() !== '');
    const pre = [
      '【更正要求 · 上一次格式不对】',
      '本卷共 ' + n + ' 道题。你上一次输出了 ' + lines.length + ' 行。',
      diag ? ('诊断：' + diag) : '',
      '请重新逐题核对后输出【恰好 ' + n + ' 行】，每行格式必须是「题号. 答案」，题号 1 到 ' + n + ' 恰好各出现一次：',
      '不要跳号、不要重复题号、不要出现 ' + n + ' 以外的题号、不要解释、不要空行。',
      '正确格式示例：1. A   2. BCD   3. 中央处理器   4. 运算器|控制器',
      '上一次你的输出（错在格式/数量，仅供自查，不要照抄）：',
      lines.slice(0, 80).join('  '),
      '',
    ].filter(x => x !== '');
    return buildAskPrompt(pre);
  }

/** 重答：带上一次的对错记录当参考，题目以新卷为准（题序可能变） */
  function buildRetryPrompt() {
    const review = String(localStorage.getItem(STORE_REVIEW) || '').trim();
    const pre = [];
    if (review) {
      pre.push('【参考】下面是上一次作答的记录，含每题对错标记：[正确] 的题沿用思路，[错误] 的题务必改正。');
      pre.push('特别注意：本卷题目顺序可能与上次不同，一切以本卷题目为准，按本卷顺序输出。');
      pre.push(...review.split('\n'));
      pre.push('');
    }
    return buildAskPrompt(pre);
  }

  /* ===== 上次作答记录（[正确]/[错误] 标记，重考时当参考） ===== */
  const RE_RIGHT = '(?:正确答案|参考答案|标准答案)';
  const RE_MINE  = '(?:我的答案|你的答案|学生答案|已选答案|我的作答|你的作答)';
  const RE_NOISE = '(?:试题解析|答案解析|题目解析|参考解析|解析\\s*[:：])';

  function scoreStateOf(sub) {
    const el = q('[ng-bind*="getScore"]', sub);
    if (!el) return 'unknown';
    const m = (el.textContent || '').trim().match(/^-?\d+(?:\.\d+)?/);
    if (!m) return 'unknown';
    const n = Number(m[0]);
    if (n === 0) return 'zero';
    return Number.isInteger(n) ? 'got' : 'unknown';
  }
  function extractPair(sub) {
    let mine = '', right = '';
    const blocks = qa('.answer-options', sub).length ? qa('.answer-options', sub) : qa('.subject-message', sub);
    for (const b of blocks) {
      const txt = short(b.textContent, 300);
      const grab = re => {
        const m = txt.match(new RegExp(re + '\\s*[:：]?\\s*([\\s\\S]*?)(?=' + RE_MINE + '|' + RE_RIGHT + '|' + RE_NOISE + '|$)'));
        return (m && m[1]) ? m[1].trim() : '';
      };
      if (!right) right = grab(RE_RIGHT);
      if (!mine) mine = grab(RE_MINE);
    }
    return { mine, right };
  }
  /** 生成「上次作答记录」文本块（题目 + [正确]/[错误]/[未知] + 我的答案） */
  function buildReviewPrompt() {
    const qs = questions();
    if (!qs.length) return null;
    const blocks = qs.map((sub, i) => {
      const st = scoreStateOf(sub);
      const tag = st === 'zero' ? '[错误]' : st === 'got' ? '[正确]' : '[未知]';
      const { mine, right } = extractPair(sub);
      const head = `${i + 1}. ${tag}` +
        (mine ? ` ｜ 我的答案：${mine}` : '') +
        (right ? ` ｜ 正确答案：${right}` : ' ｜ 本场未公布正确答案');
      const stem = stemForAI(sub);
      const optEls = qa('.option', sub);
      if (optEls.length) return `${head}\n${stem}\n${optEls.map(o => `${labelOf(o)}. ${contentOf(o)}`).join('\n')}`;
      return `${head}\n${stem}`;
    });
    return { text: blocks.join('\n') };
  }

  /* ==================== 进入考场 ==================== */
  function clickableAncestor(el) {
    let p = el;
    for (let i = 0; i < 5 && p; i++) {
      const attrs = [...(p.attributes || [])].map(a => a.name);
      if ((p.matches && p.matches('button,a')) || attrs.some(n => /ng-click|popup/.test(n))) return p;
      p = p.parentElement;
    }
    return el;
  }
  function findStartTrigger() {
    const re = /^(开始答题|继续答题|开始考试|再次答题|重新答题|再次考试|重新考试|再次作答|重新作答|继续考试|进入考试|开始作答|继续作答|返回测试|回到测试|继续测试|返回考试|进入测试)$/;
    const cands = qAll('button, a, span').filter(el => {
      if (!visible(el)) return false;
      if (!re.test((el.textContent || '').trim())) return false;
      if (el.closest('[ng-click*="takeExam"]')) return false;
      if (el.closest('.reveal-modal,.popup-area,.ivu-modal,.modal')) return false;
      return true;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    return cands[0];
  }

  /** 单次进入尝试：① 已有确认弹窗就勾选并点「开始答题」② 点文字入口 ③ 直点 takeExam */
  function clickEnterOnce() {
    const cb = qAllFirst('input[name="confirm"]');
    if (cb && visible(cb)) {
      if (!cb.checked) cb.click();
      const btn = qAllFirst('[ng-click*="takeExam"]');
      if (btn && !btn.disabled && visible(btn)) { try { btn.click(); } catch (e) {} return 'takeExam'; }
    }
    const trig = findStartTrigger();
    if (trig) { try { trig.click(); } catch (e) {} return 'trigger'; }
    const back = findReturnToExam();        // 已交卷/预览页：平台自己的「返回测试」= 再次答题入口
    if (back) { try { back.el.click(); } catch (e) {} return 'return'; }
    const direct = qAllFirst('[ng-click*="takeExam"]');
    if (direct && visible(direct)) { try { direct.click(); } catch (e) {} return 'takeExam'; }
    return '';
  }

  /** 已经在答题页的铁证：URL 判定为答题页（/exam/N/subjects#/take）+ 题目渲染出来
   *  注意：不再依赖「没有答案区」这种 DOM 猜测 —— 匹配题会自带答案区 */
  function inExamPage() { return detectPage() === 'fill' && questions().length > 0; }

  /** 强制进入考场：**立刻**试一次（不干等），之后每 0.5 秒试一次，总预算 10 秒
   *  ★ 只认「开始答题/再次答题/返回测试」这类入口文案或 takeExam 处理函数，绝不按坐标乱点；
   *    每次点击后立刻检查是否已进考场（幂等：进去了就停手，不会重复点） */
  async function forceEnter() {
    if (inExamPage()) { log('已在答题页，跳过进入步骤'); return { ok: true, msg: '已在考场' }; }
    const t0 = Date.now();
    for (let i = 1; Date.now() - t0 < 10000; i++) {
      if (!stillRun()) return { ok: false, msg: '已停止' };
      if (inExamPage()) { log('已在答题页'); return { ok: true, msg: '已在考场' }; }
      const what = clickEnterOnce();
      if (what) {
        log('点考试入口（' + what + '）：第', i, '次');
        if (await waitFor(() => inExamPage(), 1500)) { log('已进入考试'); return { ok: true, msg: '已进入考试' }; }
      } else {
        if (i === 1 || i === 4 || i === 8) log('入口按钮还没出现，继续等…（第', i, '次）');
        if (await waitFor(() => inExamPage(), 400)) { log('题目已渲染'); return { ok: true, msg: '已在考场' }; }
      }
      await sleep(500);
    }
    return { ok: false, msg: '找不到「开始答题/返回测试」入口（已自动试 10 秒）' };
  }

  let xingkaoBusy = false;
  /** 定时强制进形考任务：点「回到首页」2 秒后强点，失败每 0.5s 再点，最多 10 次；都没有就直切 formal-exam */
  async function forceXingkao() {
    if (xingkaoBusy) return;
    xingkaoBusy = true;
    for (let i = 1; i <= 10; i++) {
      const el = findByText(/^形考任务$/, 'span, a, div, button, li');
      if (el && visible(el)) {
        patchState({ pendingXingkao: 0 });
        const tgt = clickableAncestor(el) || el;
        log('强制点开形考任务：第', i, '次命中');
        try { tgt.click(); } catch (e) { log('点形考任务失败', String(e)); }
        xingkaoBusy = false;
        return;
      }
      await sleep(500);
    }
    patchState({ pendingXingkao: 0 });
    const base = courseUrlFrom(loadState().entryUrl || '') || '';
    const target = base ? base.replace(/#\/?$/, '') + '#/formal-exam' : '';
    xingkaoBusy = false;
    if (target) { log('没找到形考任务按钮，直接切 formal-exam：', target); location.href = target; }
    else log('形考任务按钮和 formal-exam 地址都没找到');
  }

  /* ==================== 交卷 ==================== */
  function findSubmitBtn() {
    let cands = qAll('a[ng-click*="calUnsavedSubjects"], button[ng-click*="calUnsavedSubjects"]');
    if (!cands.length) {
      // 各版本交卷按钮长得不一样：按处理函数名和文案兜底（排除确认弹窗的确定/提交）
      cands = qAll('a, button').filter(el => {
        const ng = el.getAttribute('ng-click') || '';
        const t = (el.textContent || '').trim();
        if (/calUnsaved|handIn|submitPaper|submitExam|finishExam/i.test(ng)) return true;
        return /^(交卷|提交试卷|交卷并查看成绩|交卷并查看结果)$/.test(t);
      });
    }
    return cands.find(visible) || cands[0] || null;
  }
  /** 点掉确认弹窗：沿用完整版验证过的全局策略，不乱改 */
  function clickConfirmDialog() {
    let n = 0;
    qAll('button, a').forEach(el => {
      if (!visible(el) || el.disabled) return;
      const t = (el.textContent || '').trim();
      const ng = el.getAttribute('ng-click') || '';
      if (/^(确定|确认|是|提交|继续|OK)$/i.test(t) || /submitAnswer/.test(ng)) {
        try { el.click(); n++; log('点确认：', t || ng); } catch (e) {}
      }
    });
    return n;
  }
  function leftExamPage() {
    if (/\/submission\//.test(location.hash || '')) return true;
    if (qAll('.subject .answer-options, .subject .subject-message').length) return true;
    return !findSubmitBtn();
  }
  async function submitAndConfirm() {
    for (let attempt = 1; attempt <= CFG.SUBMIT_TRIES; attempt++) {
      const btn = await waitFor(findSubmitBtn, 8000);
      if (!btn) return { ok: false, msg: '找不到「交卷」按钮' };
      log(`第 ${attempt} 次点交卷`);
      try { btn.click(); } catch (e) { log('click 异常', String(e)); }
      const t0 = Date.now();
      while (Date.now() - t0 < CFG.SUBMIT_WAIT) {
        clickConfirmDialog();
        await sleep(250);
        if (leftExamPage()) {
          log('交卷成功（用时', Math.round((Date.now() - t0) / 1000), '秒）');
          return { ok: true, msg: '已交卷' };
        }
      }
      log(`第 ${attempt} 次交卷后仍未离开答题页`);
      await sleep(800);
    }
    return { ok: false, msg: `连交 ${CFG.SUBMIT_TRIES} 次都没成功` };
  }

  /* ==================== 分数与评语 ==================== */
  const SCORE_MSG = {
    praise: ['稳。这分数不用多说。', '漂亮，一次到位。', '可以，收工了。', '这成绩摆出来就够了。', '干净利落，没有废话。', '这个水平，继续保持。', '没得挑，这就是标准答案。'],
    taunt:   ['及格而已，别高兴太早。', '六十多分，够用就行？', '过了，但离好还差得远。', '踩线过关，下次未必这么走运。', '这分数，勉强能看。', '及格线上下徘徊，没什么值得说的。', '过了是过了，就是不太体面。'],
    scold:   ['这分数，重考吧。', '挂了。别问为什么。', '差得太远了，回去重考！', '这个成绩，狗屎！', '不行就是不行，重考！', '要考多少分自己心里有数，别浪费时间。', '这套题做成这样，属实说不过去。'],
  };
  function pickMsg(pool) { const a = SCORE_MSG[pool]; return a[Math.floor(Math.random() * a.length)]; }
  function scoreTier(n) {
    if (n === null) return { cls: '',    label: '未知',   pool: null,    tip: '没读到分数，可能还没出分' };
    if (n >= 80)    return { cls: 'good', label: '优秀',   pool: 'praise', tip: '' };
    if (n >= 60)    return { cls: 'mid',  label: '及格',   pool: 'taunt',  tip: '' };
    return              { cls: 'low',  label: '不合格', pool: 'scold',  tip: '' };
  }
  function scanScore() {
    const cands = qAll('.score, [ng-bind*="submissionData.score"]');
    for (const el of cands) {
      const t = (el.textContent || '').trim();
      if (/^-?\d+(\.\d+)?$/.test(t)) return t;
    }
    return '';
  }
  /** ★ 交卷后「成绩」是异步渲染出来的：批量模式交完卷立刻读会读到空，
   *  于是被当成合格跳过重考（用户实测形考任务7 → 记录「未读到分 ✓」，实际只有 20 分）。
   *  这里最多等 ms 毫秒；急停/退出立即返回，不耽误停止。 */
  async function waitScoreFor(ms) {
    const t0 = Date.now();
    for (;;) {
      const sc = scanScore();
      if (sc !== '') return sc;
      if (!loadState().run) return '';
      if (Date.now() - t0 >= ms) return '';
      await sleep(400);
    }
  }
  function courseUrlFrom(entry) {
    const m = String(entry || '').match(/\/course\/(\d+)\//);
    return m ? `${location.origin}/course/${m[1]}/ng#/` : '';
  }
  /* ==================== 诊断报告 ====================
   * 页面结构是猜不准的：把「脚本看到了什么」一次性写成可复制的文本，
   * 卡住/失败时自动写进日志（点 📜 复制发我），也能点 🔍 手动抓一次。 */
  function diagReport() {
    const L = [];
    const push = (k, v) => L.push(k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
    const safe = (fn, d) => { try { return fn(); } catch (e) { return 'ERR ' + e; } };
    try {
      push('时间/版本', new Date().toLocaleString() + '  v' + VER);
      push('URL', location.href);
      push('pathname', location.pathname + '  hash=' + (location.hash || '(空)'));
      push('readyState', document.readyState);
      const pg = safe(() => detectPage());
      push('detectPage()', pg);
      push('页面标签', safe(() => TAG_MAP[pg] || ''));
      const counts = {};
      [
        'input[type=radio]', 'input[type=radio]:not([disabled])', 'input[type=checkbox]',
        'input[type=radio][disabled]', '[contenteditable="true"]', 'select', 'select.___select-answer',
        'textarea', '.answer-pool .clone-area', '.clone-area.drag-area', '.subject',
        '.answer-options', '.subject-message', '.score', '.matching-answer-box',
        '[ng-click*="takeExam"]', 'input[name="confirm"]', 'iframe',
      ].forEach(sel => { counts[sel] = safe(() => qAll(sel).length); });
      push('选择器计数', counts);
      const vis = safe(() => qAll('input[type=radio]:not([disabled]), input[type=checkbox]:not([disabled]), [contenteditable="true"]').filter(visible));
      push('可见可用的作答控件数', Array.isArray(vis) ? vis.length : vis);
      if (Array.isArray(vis) && vis.length) push('前几个控件 HTML', vis.slice(0, 5).map(e => e.outerHTML.slice(0, 130)));
      push('questions() 题数', safe(() => questions().length));
      push('scanScore()', safe(() => scanScore()));
      push('返回测试入口', safe(() => qAll('[ng-click*="hasUnsavedSubjects"]').map(e => ({ vis: visible(e), txt: short(e.textContent, 12), ng: String(e.getAttribute('ng-click')).slice(0, 140) }))));
      push('入口类按钮(可见)', safe(() => qAll('button, a, span, div').filter(visible).map(e => (e.textContent || '').trim()).filter(t => t && t.length <= 16 && /答题|考试|测试|作答|返回|继续|开始|重考|重做/.test(t)).slice(0, 30)));
      push('iframe', safe(() => qAll('iframe').map(f => { try { return { src: String(f.src).slice(0, 90), 同源: !!f.contentDocument }; } catch (e) { return { src: String(f.src).slice(0, 90), 同源: false }; } })));
      const s0 = safe(() => qAll('.subject')[0]);
      push('第一题 HTML(截断700)', s0 && s0.outerHTML ? s0.outerHTML.slice(0, 700) : '(没有 .subject)');
      push('state', safe(() => loadState()));
      push('doneKeys', [...doneKeys]);
      push('busy/busyPage/lastPage', { busy, busyPage, lastPage });
      push('ui.scoreShown/scoreTimer', { shown: ui.scoreShown, timer: ui.scoreTimer });
    } catch (e) { L.push('诊断出错: ' + e); }
    return L.join('\n');
  }

  /** 平台自己的「返回测试」入口：ng-click="hasUnsavedSubjects('/course/…#/exam/123', '返回测试')"
   *  实测用户的考试就是这种「学习活动全屏模式」——第一个参数就是再次考试的答题页地址，
   *  比我们猜地址准得多（返回测试按钮在已交卷/预览时显示） */
  function findReturnToExam() {
    for (const el of qAll('[ng-click*="hasUnsavedSubjects"]')) {
      if (!visible(el)) continue;
      const m = String(el.getAttribute('ng-click') || '').match(/hasUnsavedSubjects\(\s*'([^']+)'\s*,/);
      if (m && /#\/exam\/\d+/.test(m[1])) return { el, url: m[1] };
    }
    return null;
  }
  /** 重答目标：① 平台「返回测试」给的地址 ② 上次真正答过题的地址(fillUrl) ③ 入口地址
   *  ★ 不要剥 #hash —— 全屏模式下 #/exam/{id} 才是答题页，剥掉就掉回形考任务列表页（回不去考试） */
  function retryTarget(s) {
    const back = findReturnToExam();
    if (back && back.url) return back.url;
    return (s && (s.fillUrl || s.entryUrl)) || location.href;
  }
  /** 回答题页：目标地址和当前地址一样时 `location.href=` 是「原地不动」（用户实测的卡死原因之一），
   *  这时先点平台自己的「返回测试」，再不行就整页刷新让 Angular 重新路由 */
  function goAnswerPage(target) {
    const t = target || retryTarget(loadState());
    if (t && t !== location.href) { log('跳转答题页', t); location.href = t; return; }
    /* ★ 已经站在「开始答题」入口页（#/exam/N，且看得见「开始答题」按钮）：
       不刷新、不跳转，直接交给进入流程：点「开始答题」→ 勾「我已知晓考试要求」→ takeExam()。
       旧版在这里 reload，Angular 重新路由后又回到同一个列表页，于是永远进不了考场
       （用户实测：「点击再考一次就直接卡在没找到可重新作答的入口」）。 */
    if (detectPage() === 'landing') { log('已在「开始答题」入口页，交给进入流程点按钮'); return; }
    const back = findReturnToExam();
    if (back && back.el) { log('点平台的「返回测试」入口（地址相同，靠它换视图）'); try { back.el.click(); return; } catch (e) {} }
    log('地址与当前相同且没有返回测试入口 → 整页刷新重新路由');
    location.reload();
  }

  /* ==================== 主流程：问 AI → 填入 → 全中交卷 ==================== */
  function stillRun() { return !!loadState().run; }

  /** 失败报告里那个「按 AI 顺序先填上」的按钮 + 说明（动态插入，靠 ShadowRoot 委托点击） */
  function looseBtnHTML(lines, n) {
    return '<div class="hint" style="margin-top:7px">AI 这次给了 <b>' + lines + '</b> 行答案、本卷 <b>' + n + '</b> 题。' +
      '想先填上（按 AI 给的顺序硬填，多出来的行丢掉、少的部分留空）就点下面这个：</div>' +
      '<button class="ghost" id="loosebtn" style="width:100%;margin-top:6px">🖐 按 AI 顺序先填上（不自动交卷，剩下的手动）</button>';
  }
  /** ★ 宽松填入：只填、绝不交卷 */
  async function looseFill() {
    const txt = String(localStorage.getItem(STORE_LOOSE) || '');
    if (!txt.trim()) { setNotice(CFG.PREFIX + '还没有可用的 AI 答案（先点「AI 自动答题」拿到答案再来）', 'bad'); return; }
    setStatus('宽松填入：等题目渲染…');
    await waitOptionsStable(CFG.FILL_WAIT);
    const qs = questions();
    if (!qs.length) { setNotice(CFG.PREFIX + '没读到题目，稍后再试', 'bad'); return; }
    const lo = looseTokens(txt, qs.length);
    log('宽松填入：AI 给了', lo.lines, '行 → 本卷', qs.length, '题（截断/补空后', lo.tokens.length, '个，判定 ' + lo.how + '）');
    setStatus('宽松填入中（按 AI 顺序硬填 · 不自动交卷）…');
    const res = await fillAnswers(lo.tokens, (i, n) => setStatus('宽松填入中 ' + i + '/' + n));
    const okN = res.report.filter(x => x.res.startsWith('✅')).length;
    const rest = res.report.filter(x => !x.res.startsWith('✅'));
    const rep = '<div class="sum">宽松填入：成功 ' + okN + ' / ' + res.total + '</div>' +
      rest.map(x => '<div><b>' + x.no + '</b> ' + x.type + ' · ' + esc(x.tok) + ' → <span class="' + (x.res.startsWith('❌') ? 'bad' : 'skip') + '">' + esc(x.res) + '</span></div>').join('') +
      '<div class="hint" style="margin-top:6px">⚠️ ' +
      (lo.extra ? 'AI 多给了 <b>' + lo.extra + '</b> 行，已按顺序取前 ' + res.total + ' 行，可能错位；' : '') +
      '没填上的（' + rest.length + ' 题）请手动选。<b>本模式不会自动交卷</b>，你核对完自己点页面上的交卷。</div>';
    ui.notice = CFG.PREFIX + '宽松填入完成：成功 ' + okN + '/' + res.total +
      (rest.length ? '，剩下 ' + rest.length + ' 题请手动选' : '') + '；不会自动交卷，自己核对后手动交卷。';
    ui.noticeCls = okN ? 'ok' : 'bad';
    advance({ run: false, step: 'idle' });
    buildUI();
    renderResult(rep);
    log('宽松填入完成：', okN, '/', res.total, '（未交卷）');
  }

  function failRun(msg, detail) {
    const s = loadState();
    log('===== 自动诊断（失败现场，点 📜 复制发我）=====\n' + diagReport());   // ★ 每次失败都把现场写进日志
    if (s.batch && loadBatch().active) {
      // 批量中：记录跳过原因，回列表跑下一场（不阻塞后续）
      batchRecord(s.batchTitle || '未知考试', '跳过：' + String(msg).replace(/<[^>]+>/g, ''));
      advance({ run: false, step: 'idle' });
      const base = courseUrlFrom(s.entryUrl || location.href) || '';
      const back = base ? base.replace(/#\/?$/, '') + '#/formal-exam' : '';
      if (back && !/formal-exam/.test(location.hash || '')) { location.href = back; return; }
      buildUI();
      return;
    }
    ui.notice = CFG.PREFIX + msg; ui.noticeCls = 'bad';
    advance({ run: false, step: 'idle' });
    buildUI();                       // 刷新面板（运行中界面 → 待机界面）
    if (detail) renderResult(detail);
    log('流程终止：', msg);
  }

  async function runAI() {
    const s = loadState();
    const retry = s.flow === 'retry';
    setStatus(retry ? '重答模式：等待题目渲染…' : 'AI 自动答题：等待题目渲染…');
    try { localStorage.removeItem(STORE_LOOSE); } catch (e) {}     // 新一轮开始：清掉上一轮的宽松填入原料
    await waitOptionsStable(CFG.FILL_WAIT);
    await sleep(300);
    const qs = questions();
    log('题目', qs.length, '道，选项', qAll('.option').length, '个');
    if (!qs.length) return failRun('没读到题目，已停下（页面可能还没渲染完，稍后再试）');

    const prompt = retry ? buildRetryPrompt() : buildAskPrompt();
    if (!prompt) return failRun('生成提示词失败，已停下');

    startThink({
      label: `正在询问大肥鱼…（${retry ? '重答模式，最长 3 分钟' : '最长 2 分钟'}，可按急停）`,
      fix: false, n: qs.length, spin: '蓝色大肥鱼正在思考中',
    });
    const r = await callAI(prompt, null, retry ? CFG.AI_TIMEOUT_RETRY : CFG.AI_TIMEOUT);
    stopThink();
    if (r.ok) saveDur(qs.length, r.ms || 0);      // 记下这次耗时，下次"平时约 N 秒"更准
    if (!stillRun()) { log('AI 返回前已被停止'); return; }
    if (!r.ok) {
      /* ★ 失败现场落盘：面板上那句可能被截图不到，写进 localStorage 便于事后查（含服务端原话/思考过程片段） */
      try {
        localStorage.setItem('ouchn_ai_err_v1', JSON.stringify({
          ts: Date.now(), err: r.err, reasoning: String(r.reasoning || '').slice(0, 1500),
          raw: String(r.raw || '').slice(0, 1500), promptLen: prompt.length, retry, model: (loadAPI().model || API_DEFAULT_MODEL),
        }));
      } catch (e) {}
      return failRun('AI 调用失败：' + esc(r.err) + '。点上方按钮可重试。');
    }

    let cleaned = cleanAIReply(r.text);
    try {
      localStorage.setItem(STORE_ANS, cleaned);
      localStorage.setItem(STORE_AIPROC, JSON.stringify({
        ts: Date.now(), ms: r.ms || 0, model: (loadAPI().model || API_DEFAULT_MODEL),
        prompt, reasoning: r.reasoning || '', raw: r.text, cleaned,
      }));
    } catch (e) {}

    /* ---- 解析：优先按题号对齐（多几行少几行都不怕），完全没题号才退回按行数 ---- */
    let al = alignTokens(cleaned, qs.length);
    log('解析：', al.how, '｜行数', al.lines, '｜题目', qs.length,
      al.missing.length ? '｜缺题号 ' + al.missing.join(',') : '',
      al.dup.length ? '｜重复题号 ' + al.dup.join(',') : '');

    if (al.how !== 'numbered' || al.missing.length) {
      /* ★ 绝不猜「删哪一行」（删错位置后面全错位）。带上精确诊断再问一次：
         ① 行数不符 ② 有题号但缺号/重号 —— 都要求按「题号. 答案」重答一遍。 */
      const diag = al.how === 'mismatch'
        ? ('你上次回了 ' + al.lines + ' 行，本卷是 ' + qs.length + ' 题，行数不符。')
        : ('你上次的回复里这些题号缺失或重复：' + al.missing.slice(0, 30).join('、') + (al.missing.length > 30 ? ' 等' : '') + '。');
      log('回炉重问：', diag);
      startThink({
        label: al.how === 'mismatch'
          ? `AI 回了 <b>${al.lines}</b> 行、题目 <b>${qs.length}</b> 道 —— 正在回炉重造…`
          : `AI 少了 <b>${al.missing.length}</b> 道题（题号 ${esc(al.missing.slice(0, 6).join('、'))}${al.missing.length > 6 ? ' 等' : ''}）—— 正在回炉重造…`,
        fix: true, n: qs.length, spin: `回炉重造中：让大肥鱼按「题号. 答案」重答一遍（共 ${qs.length} 题）`,
      });
      const r2 = await callAI(buildFixPrompt(cleaned, qs.length, diag), null, retry ? CFG.AI_TIMEOUT_RETRY : CFG.AI_TIMEOUT);
      stopThink();
      if (!stillRun()) { log('回炉前已被停止'); return; }
      if (r2.ok) {
        const c2 = cleanAIReply(r2.text);
        const a2 = alignTokens(c2, qs.length);
        const good = a2.how === 'numbered' ? a2.missing.length === 0 : a2.tokens.length === qs.length;
        log('回炉结果：', a2.how, '｜行数', a2.lines, a2.missing.length ? '｜仍缺 ' + a2.missing.join(',') : '', good ? '✅ 对齐' : '❌ 仍不符');
        if (good) {
          cleaned = c2; al = a2;
          try {
            localStorage.setItem(STORE_ANS, cleaned);
            localStorage.setItem(STORE_AIPROC, JSON.stringify({
              ts: Date.now(), ms: r2.ms || 0, model: (loadAPI().model || API_DEFAULT_MODEL),
              prompt: '（回炉重问）', reasoning: r2.reasoning || '', raw: r2.text, cleaned,
            }));
            localStorage.removeItem('ouchn_ai_err_v1');
          } catch (e) {}
        }
      } else {
        log('回炉请求失败：', r2.err);
      }
    }

    /* 仍完全对不齐：
       · 完全没题号 + 行数不符 → 位置不可信，整卷取消（绝不猜位置）
       · 有题号体系但缺号 → 编号可信，缺的题位留空，先安全填入已知的，精确报出缺哪几题，绝不自动交卷 */
    if (al.how === 'mismatch' && al.tokens.length !== qs.length) {
      try {
        localStorage.setItem('ouchn_ai_err_v1', JSON.stringify({
          ts: Date.now(), err: '行数不符 ' + al.tokens.length + ' ≠ ' + qs.length, retry,
          model: (loadAPI().model || API_DEFAULT_MODEL), promptLen: prompt.length,
          raw: cleaned.slice(0, 1500), shape: shapeReport(al.tokens, qs),
        }));
        localStorage.setItem(STORE_LOOSE, cleaned);      // ★ 留给「按 AI 顺序先填上」按钮
      } catch (e) {}
      return failRun(`AI 回了 <b>${al.tokens.length} 行</b>、题目 <b>${qs.length} 道</b>（回复里没有题号，没法确认位置），自动回炉一次仍不符，已取消填入（防错位）。<br>${esc(shapeReport(al.tokens, qs))}<br>点上方按钮可重试。`,
        looseBtnHTML(al.tokens.length, qs.length));
    }
    const missNo = al.missing.slice();
    const tokens = al.tokens;
    if (missNo.length) log('按题号对齐后仍缺题', missNo.join('、'), '→ 先填已知的，不自动交卷');

    setStatus('AI 答案已就位，开始填入…');
    const res = await fillAnswers(tokens, (i, n) => setStatus(`AI 填入中 ${i}/${n}`));
    const okN = res.report.filter(x => x.res.startsWith('✅')).length;
    const rest = res.report.filter(x => !x.res.startsWith('✅'));
    const bad = looseSubmitOn() ? rest.filter(x => x.type !== '其他' && x.type !== '匹配题' && x.type !== '完形填空') : rest;
    log('填入完成：成功', okN, '/', res.total);
    if (!stillRun()) { log('填入后已被停止，不交卷'); return; }

    if (!(okN > 0 && res.total > 0 && bad.length === 0)) {
      const rep = `<div class="sum">填入报告：成功 ${okN} / ${res.total}</div>` +
        rest.map(x => `<div><b>${x.no}</b> ${x.type} · ${esc(x.tok)} → <span class="${x.res.startsWith('❌') ? 'bad' : 'skip'}">${esc(x.res)}</span></div>`).join('') +
        looseBtnHTML(al.tokens.length, qs.length);
      try { localStorage.setItem(STORE_LOOSE, cleaned); } catch (e) {}   // ★ 留给「按 AI 顺序先填上」
      const why = missNo.length
        ? `AI 漏了 <b>${missNo.length}</b> 题（题号 ${esc(missNo.slice(0, 20).join('、'))}${missNo.length > 20 ? ' 等' : ''}），其余已按题号安全填入`
        : `填入完成但没全中（成功 ${okN}/${res.total}）`;
      return failRun(`${why}，<b>不自动交卷</b>。`, rep);
    }

    setStatus(`核对无误（${okN}/${res.total} 全部命中），自动交卷…`);
    await sleep(1200);                                   // 给急停留一个窗口
    if (!stillRun()) { log('交卷前已被停止'); return; }
    advance({ step: 'submitted' });                      // ★ 先落状态再交卷（整页重载会吞掉之后的代码）
    const r2 = await submitAndConfirm();
    if (!stillRun()) { log('交卷确认期间页面已切换，交给新页面继续'); return; }   // 别覆盖新页面的状态/提示
    if (r2.ok) setStatus(r2.msg + '，等待成绩…');
    else failRun(esc(r2.msg) + '。页面上的「交卷」按钮还在，可以手动交。');
  }

  /* ==================== 状态机分发 ==================== */
  let busy = false, busyPage = '';
  let grabSeenAt = 0;                 // 本页第一次看到「成绩页」的时刻（页面级变量：跳页/刷新自动归零）
  const doneKeys = new Set();

  async function step(page) {
    const s = loadState();
    if (!s.run) return;
    const key = page + '|' + s.step;
    if (doneKeys.has(key)) { log('本页已完成过：' + key + '（卡住就点急停再来）'); return; }
    if (isLocked()) { log('本步被锁跳过（还剩 ' + Math.ceil((s.lockUntil - Date.now()) / 1000) + ' 秒）'); return; }

    /* ★ 自愈：步骤和页面不匹配时绝不能干等
     *  历史 bug：重答跳回考试后，页面短暂算「答题页」→ 步骤被推到 fill，
     *  随后平台又跳回入口页/成绩页 → 步骤停在 fill 而页面不是 fill → 状态机全部分支不匹配 → 永久卡在「AI 答题中」 */
    if (s.step === 'fill' && page !== 'fill') {
      const soft = (page === 'landing' || !page);      // 入口页 / 跳转中的空白页：可能只是过渡，先给 8 秒
      if (soft) {
        if (!s.mismatchAt) { patchState({ mismatchAt: Date.now() }); log('自愈：该答题了但页面是「' + (page || '跳转中') + '」，先观察 8 秒'); return; }
        if (Date.now() - s.mismatchAt < 8000) return;
        log('自愈：确认停在入口页 → 重新走「进入考场」');
        doneKeys.clear(); advance({ step: 'entering' });
        return;
      }
      log('自愈：该答题了但当前页面是「' + page + '」→ 停下，不乱动');
      advance({ step: 'done', run: false });
      setNotice(CFG.PREFIX + '当前页面没有可作答的题目（' + page + '），已停下。请从课程页重新进入考试，或点急停后重试。', 'bad');
      buildUI();
      return;
    }
    if (s.mismatchAt) patchState({ mismatchAt: 0 });    // 页面恢复正常，清掉观察标记
    if (page !== 'grab') grabSeenAt = 0;                // 离开成绩页 → 下次进来重新计时
    /* ★ 自愈：重答流程落到了成绩页（没进考场）→ 最多试 3 次：先点平台「返回测试」→ 再跳地址 → 再整页刷新
     *  旧版只试一次就放弃，于是「再考一次」经常直接死在成绩页（用户实测的 bug） */
    if (s.step === 'entering' && page === 'grab') {
      const tries = s.bounceTries || 0;
      if (!grabSeenAt) grabSeenAt = Date.now();       // 本页第一次看到成绩页：先记时刻
      const waitOk = Date.now() - (s.bouncedAt || 0) > 1500;
      /* ★★ 修「卡半途」的关键：刚点过/刚刷过时，页面还在换视图 —— 这是「正在等」，
         不是「已经试过了」。旧代码不判断就往下溜到「放弃」，而运行中心跳只有 500ms，
         所以下一拍立刻命中放弃分支 → 只试 1 次就停手（用户实测：「点让 AI 重新作答卡半途」）。 */
      if (!waitOk) return;
      if (Date.now() - grabSeenAt < 2500) return;     // 给 Angular 2.5 秒换视图/渲染入口（页面级计时，跳页重算）
      /* 这页确实没有任何重答入口（既没「开始答题」也没平台的「返回测试」）→ 别再刷新打转 */
      const entryNow = !!(findStartTrigger() || findReturnToExam()
        || q('a.take-exam') || q('[ng-click*="takeExam"]') || q('[ng-click*="openStartExam"]') || q('[ng-click*="hasUnsavedSubjects"]'));
      if (!entryNow) {
        log('自愈：这页没有任何「开始答题/返回测试」入口 → 不再刷新打转');
        log('===== 自动诊断（卡住现场，点 📜 复制发我）=====\n' + diagReport());
        advance({ step: 'done', run: false });
        setNotice(CFG.PREFIX + '这一场没有可重新作答的入口（可能答题次数已用尽）。请从课程页重新进入考试。', 'bad');
        buildUI();
        return;
      }
      if (tries < 3) {
        const back = findReturnToExam();
        patchState({ bouncedAt: Date.now(), bounceTries: tries + 1 });
        if (back && back.el) {
          log('自愈(' + (tries + 1) + '/3)：点平台的「返回测试」入口 →', back.url);
          try { back.el.click(); } catch (e) { log('点返回测试失败', String(e)); }
          return;
        }
        const tgt = retryTarget(s);
        if (tgt && tgt !== location.href) {
          log('自愈(' + (tries + 1) + '/3)：跳回答题页地址', tgt);
          patchState({ fillUrl: tgt });
          location.href = tgt;
          return;
        }
        log('自愈(' + (tries + 1) + '/3)：地址与当前相同 → 整页刷新，让 Angular 重新路由');
        location.reload();
        return;
      }
      log('自愈：已试 ' + tries + ' 次仍停在成绩页 → 停下等人工处理');
      log('===== 自动诊断（卡住现场，点 📜 复制发我）=====\n' + diagReport());
      advance({ step: 'done', run: false });
      setNotice(CFG.PREFIX + '平台没让脚本回到可作答的试卷（已试 ' + tries + ' 次）。点 🔍 复制诊断报告发我。', 'bad');
      buildUI();
      return;
    }

    if ((page === 'landing' || page === 'fill' || !page) && s.step === 'entering') {
      // ★ 锁只能用来挡重复触发，不能长：页面一跳转（整页重载）doneKeys 就清空了，
      //   60 秒长锁会把「已经进考场、该跑答题了」这一步硬挡在门外 → 表现就是「卡很久」
      doneKeys.add(key); lock(CFG.LOCK_MS);
      if (inExamPage()) {
        log('已在答题页，直接开跑（不等 5 秒）');
        advance({ step: 'fill' });
        return;
      }
      setStatus('正在进入考场…');
      const r = await forceEnter();
      if (r.ok) advance({ step: 'fill' });
      else { doneKeys.delete(key); failRun(r.msg); }
      return;
    }
    if (page === 'fill' && s.step === 'fill') {
      // ★ 不再锁 5 分钟：AI 一轮最长 3 分钟由页内 busy + doneKeys 守着；
      //   长锁只会让「AI 请求被跳转打断」之后白白等 5 分钟
      doneKeys.add(key); lock(15000);
      if (s.fillUrl !== location.href) patchState({ fillUrl: location.href });   // ★ 记住真正能答题的地址，供重答回跳
      await runAI();
      return;
    }
    if (page === 'grab' && s.step === 'submitted') {
      doneKeys.add(key);
      if (s.batch) {
        // 批量模式：<80 分触发重考（同场最多 2 次），合格才进下一场
        setStatus('交卷成功 —— 正在读取本场成绩（最多等 12 秒）…' + spinHTML('读取成绩中：等服务器把分数渲染出来', false));
        const score = await waitScoreFor(12000);   // ★ 先等成绩渲染（原来立刻读 → 常读到空 → 误判合格）
        const num = score === '' ? null : Number(score);
        const title = s.batchTitle || '未知考试';
        const b = loadBatch();
        b.attempts = b.attempts || {};
        const tries = b.attempts[title] || 0;
        b.attempts[title] = tries + 1;
        const base = courseUrlFrom(s.entryUrl || location.href) || '';
        const back = base ? base.replace(/#\/?$/, '') + '#/formal-exam' : '';
        const fail = num !== null && num < 80;
        b.results.push({ title, msg: (score ? score + ' 分' : '已完成（等了 12 秒也没读到分，按合格处理）') + '（第 ' + (tries + 1) + ' 次）' + (fail ? ' 不合格' : ' ✓') });

        if (!fail) {
          if (b.retry === title) b.retry = null;
          b.idx++;
          saveBatch(b);
          advance({ step: 'idle', run: false });
          log('批量：本场合格（' + (score || '?') + ' 分），返回列表');
          if (back) location.href = back; else buildUI();
          return;
        }
        if (tries + 1 >= 2) {
          b.active = false;
          saveBatch(b);
          advance({ step: 'idle', run: false });
          setStickyNotice(CFG.PREFIX + '已达最大重试次数！请检查题目合法性并自行检查题目！<br>' + esc(title) + ' 两次成绩均不合格，批量已紧急停止。', 'bad');
          if (back) location.href = back; else buildUI();
          return;
        }
        saveBatch(b);
        const go = await retryCountdown(title);   // 红色 3 秒倒计时，可紧急暂停
        if (!go) {
          const b3 = loadBatch();
          b3.active = false;
          saveBatch(b3);
          advance({ step: 'idle', run: false });
          setStickyNotice(CFG.PREFIX + '已紧急暂停：' + esc(title) + ' 待重考（第 ' + (tries + 2) + ' 次），点「一键全部考试」可继续。', 'bad');
          if (back) location.href = back; else buildUI();
          return;
        }
        const pr = buildReviewPrompt();
        if (pr && pr.text) { try { localStorage.setItem(STORE_REVIEW, pr.text); } catch (e) {} }
        const b4 = loadBatch();
        b4.retry = title;
        saveBatch(b4);
        log('成绩不合格（' + score + ' 分），重考：', title);
        if (back) { location.href = back; return; }
        saveState({ run: true, step: 'entering', entryUrl: s.entryUrl || location.href, tries: 0, lockUntil: 0, flow: 'retry', batch: true, batchTitle: title });
        doneKeys.clear();
        return;
      }
      advance({ step: 'done', run: false });
      setNotice(CFG.PREFIX + 'AI 自动答题跑完了！正在读取成绩…', 'ok');
      buildUI();          // ★ 收尾必须重绘（别把「思考中」那屏留在面板上，看着像卡死）
      return;
    }
  }

  async function automation(page) {
    if (busy) {
      if (page === busyPage) return;          // 同一页面：真的有任务在跑，别重入
      log('页面已切换（' + busyPage + '→' + page + '），丢弃上一页未完成的任务');
      busy = false;                           // ★ 旧任务作废，别让它把新页面堵死（历史 bug：卡在「运行中」）
    }
    busy = true; busyPage = page;
    try { await step(page); } catch (e) { log('状态机异常', String(e)); console.warn('[国开AI纯净版]', e); }
    busy = false;
  }

  function startAI() {
    if (loadBatch().active) { setNotice(CFG.PREFIX + '批量考试进行中——先点「⏹ 停止批量」再手动开跑', 'bad'); buildUI(); return; }
    const cfg = loadAPI();
    if (!cfg.base || !cfg.key) {
      ui.settingsOpen = true;
      ui.notice = CFG.PREFIX + '先在设置里填 API 接口和密钥（' + (!cfg.key ? '密钥为空' : '接口为空') + '），点右上角 ⚙ 设置。';
      ui.noticeCls = 'bad';
      buildUI();
      return;
    }
    resetState();
    ui.notice = '';
    ui.scoreShown = false; ui.scoreTimer = false;      // ★ 新一轮：允许下次成绩卡重新弹（否则第二场不出卡）
    const onFill = detectPage() === 'fill';
    saveState({ run: true, step: onFill ? 'fill' : 'entering', entryUrl: location.href, tries: 0, lockUntil: 0, flow: 'ai' });
    doneKeys.clear(); LOGS.length = 0;
    log('启动 AI 自动答题 | 入口：' + location.href);
    buildUI();
    automation(detectPage());
  }

  /* ==================== UI ==================== */
  const ui = { notice: '', noticeCls: '', settingsOpen: false, scoreShown: false, scoreTimer: null, root: null, page: null, repaint: null };

  function setStatus(txt, cls) {
    if (ui.status) { ui.status.innerHTML = txt; ui.status.className = 'stat' + (cls ? ' ' + cls : ''); }
  }
  /** 统一的等待动画块：fix=false 蓝色「正在思考」，fix=true 橙色「回炉重造」
   *  ★ 只留文字呼吸 + 点点 + 火苗，不再画那根滑动条（上面的进度条已经是唯一一根，两根并排太丑） */
  function spinHTML(txt, fix) {
    return `<div class="think${fix ? ' fix' : ''}">` +
           `<div class="thinktxt">${txt}</div>` +
           (fix ? '<div class="thinksteps"><b></b><b></b><b></b></div>' : '') + '</div>';
  }

  /* ==================== 等待期「还活着的证据」 ====================
   * 长难题 AI 可能要想 1~3 分钟，只放一个滑动条会让人以为假死。这里每秒刷新一次：
   *   ① 跳动的秒数（数字在动本身就是最强证据 —— 真卡死它就不动了）
   *   ② 心跳绿点（呼吸动画，被浏览器节流时也会明显变慢 → 顺便提示后台问题）
   *   ③ 阶段文案：连接 → 读题 → 思考 → 组织答案 → 服务器偏慢（不是死了）
   *   ④ 进度条 + 历史平均用时（用以往成功调用的 ms 估算，"平时约 26 秒"）
   *   ⑤ 页面在后台时明确警告（后台标签定时器会被降频，本来就显得卡）
   * 另外把标签页标题也改成「⏳ 已等待 N 秒」，面板没露出来时也能看出在跑。 */
  const STORE_DUR = 'ouchn_ai_dur_v1';
  let thinkTimer = null, thinkT0 = 0, thinkOpt = null, thinkTitle = '';
  let aiEscalated = false;        // callAI 内部：本轮是否已经"加大额度重答"

  function saveDur(n, ms) {
    if (!(ms > 1000)) return;
    try {
      const a = JSON.parse(localStorage.getItem(STORE_DUR) || '[]');
      a.push({ n: n || 0, ms, ts: Date.now() });
      localStorage.setItem(STORE_DUR, JSON.stringify(a.slice(-8)));
    } catch (e) {}
  }
  function avgDur(n) {
    try {
      const a = JSON.parse(localStorage.getItem(STORE_DUR) || '[]').filter(x => x && x.ms > 1500);
      if (!a.length) return 0;
      const near = a.filter(x => Math.abs((x.n || 0) - n) <= Math.max(6, n * 0.3));
      const use = near.length ? near : a;     // 有相近题量的就用它（哪怕只有一条），没有才退回整体平均
      return Math.round(use.reduce((s, x) => s + x.ms, 0) / use.length);
    } catch (e) { return 0; }
  }
  /** ★ 注意单位：sec 是秒，avgMs 是毫秒 —— 之前两处混着比，导致进度条恒为 0%、文案永远停在"正在思考" */
  function phaseText(sec, avgMs, n) {
    const a = (avgMs || 0) / 1000;
    if (sec < 3) return '正在连接服务器…';
    if (sec < 9) return '大肥鱼在读题（' + n + ' 道）…';
    if (!a) return '大肥鱼正在思考…';
    if (sec < a * 0.85) return '大肥鱼正在思考…';
    if (sec < a * 1.6) return '正在组织答案…';
    if (sec < Math.max(90, a * 3)) return '题量大/题难，服务器还在算…';
    return '这次格外慢，仍在等…（可按急停，或稍后重试）';
  }
  function renderThink() {
    if (!ui.status || !thinkOpt) return;
    const sec = Math.max(0, Math.round((Date.now() - thinkT0) / 1000));
    const n = thinkOpt.n || 0;
    const avgMs = avgDur(n);                       // 毫秒
    const avgSec = Math.round(avgMs / 1000);
    const pct = Math.min(95, Math.round((avgMs ? sec / (avgMs / 1000 * 1.6) : sec / 120) * 100));
    const esc = aiEscalated;
    const label = esc ? '大肥鱼上一轮只写了思考、没给答案 —— 正在加大额度回炉重答…' : thinkOpt.label;
    const spinTxt = esc ? '回炉重造中：这次给它 12288 token' : (thinkOpt.spin || '蓝色大肥鱼正在思考中');
    const isFix = esc || !!thinkOpt.fix;
    ui.status.innerHTML =
      label +
      '<div class="progline' + (isFix ? ' fix' : '') + '"><b style="width:' + pct + '%"></b></div>' +
      '<div class="live' + (esc ? ' esc' : '') + '"><span class="dot"></span>已等待 <b>' + sec + '</b> 秒' +
      (avgSec ? ' · 平时约 ' + avgSec + ' 秒' : '') + ' · ' + phaseText(sec, avgMs, n) + '</div>' +
      spinHTML(spinTxt, isFix) +
      (document.hidden ? '<div class="warnline">⚠️ 页面在后台：浏览器会把定时器降频，看起来会更「卡」——切回前台就恢复正常。</div>' : '');
    try { document.title = '⏳ 已等待 ' + sec + ' 秒 · 大肥鱼思考中'; } catch (e) {}
  }
  /** 开始「活着」的展示：label=顶部主文案，fix=橙色回炉样式，n=题数，spin=动画下的说明 */
  function startThink(opt) {
    stopThink();
    thinkOpt = opt || {};
    thinkT0 = Date.now();
    aiEscalated = false;
    try { if (!thinkTitle) thinkTitle = document.title; } catch (e) {}
    renderThink();
    thinkTimer = setInterval(() => { try { renderThink(); } catch (e) {} }, 1000);
  }
  function stopThink() {
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    thinkOpt = null;
    try { if (thinkTitle) { document.title = thinkTitle; thinkTitle = ''; } } catch (e) {}
  }
  function setNotice(txt, cls) {
    ui.notice = txt; ui.noticeCls = cls || '';
    setStatus(txt, cls);
    if (ui.res && !ui.scoreShown) {
      ui.res.innerHTML = `<div class="${cls || 'bad'}">${txt}</div>`;
      ui.res.classList.add('on');
    }
  }
  function renderResult(html) {
    if (!ui.res || ui.scoreShown) return;
    ui.res.innerHTML = html;
    ui.res.classList.add('on');
  }

  const CSS = `
    *{box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    .panel{width:390px;background:#fff;border-radius:14px;border:1px solid #dfe7f2;
           box-shadow:0 14px 44px rgba(18,42,80,.28);overflow:hidden}
    .hd{display:flex;align-items:center;gap:9px;padding:11px 13px;cursor:move;user-select:none;
        background:linear-gradient(135deg,#1f3f68,#3d76b0);color:#fff}
    .ttl{font-size:13px;font-weight:700;letter-spacing:.4px}
    .sub{font-size:10px;opacity:.78;margin-top:1px}
    .tag{font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.22);white-space:nowrap}
    .grow{flex:1}
    .ico{cursor:pointer;min-width:24px;height:24px;line-height:22px;text-align:center;border-radius:7px;
         background:rgba(255,255,255,.16);font-size:13px;padding:0 5px;transition:.15s}
    .ico:hover{background:rgba(255,255,255,.32)}
    .bd{padding:13px}
    .collapsed .bd{display:none}
    .hint{font-size:11px;color:#7b8aa0;margin:7px 0 11px;line-height:1.7}
    .hint b{color:#3d76b0}
    .row{display:flex;gap:8px}
    button{border:0;border-radius:9px;padding:10px 0;font-size:13px;font-weight:700;cursor:pointer;transition:.15s}
    button:active{transform:scale(.97)}
    .primary{flex:1;background:#3d76b0;color:#fff}
    .primary:hover{background:#32628f}
    .ghost{background:#f0f4f9;color:#5b6b80}
    .ghost:hover{background:#e4ebf4}
    .danger{background:#c0392b;color:#fff}
    .aibeta{width:100%;padding:14px 0;font-size:15px;font-weight:800;color:#fff;border:0;border-radius:11px;
            letter-spacing:1px;cursor:pointer;transition:.15s;
            background:linear-gradient(135deg,#2563b0,#4a8fd4);box-shadow:0 6px 18px rgba(37,99,176,.35)}
    .aibeta:hover{filter:brightness(1.09)}
    .stat{font-weight:700;margin-bottom:9px;line-height:1.7}
    .step{font-size:11px;color:#7b8aa0;margin-bottom:10px}
    .ft{font-size:10px;color:#aab6c6;text-align:right;margin-top:8px}
    .result{margin-top:11px;font-size:12px;line-height:1.9;color:#33475f;max-height:220px;overflow:auto}
    .sum{font-weight:700;margin-bottom:4px}
    .ok{color:#18895b}.bad{color:#c0392b}.skip{color:#98a6b8}
    .log{font:11px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;
         max-height:220px;overflow:auto;background:#f7fafd;border-radius:8px;padding:8px;color:#33475f}
    .setrow{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#5b6b80;margin:10px 0 11px}
    .setrow input{width:56px;border:1px solid #cdd9e8;border-radius:7px;padding:5px 7px;font-size:12px;
                  text-align:center;outline:none;color:#1b2b40;font-family:inherit}
    .setrow input:focus{border-color:#3d76b0;box-shadow:0 0 0 2px rgba(61,118,176,.12)}
    .think{margin:12px 0 4px}
    .thinkbar{height:6px;border-radius:4px;background:#e9eff7;overflow:hidden;position:relative}
    .thinkbar i{position:absolute;top:0;bottom:0;left:-40%;width:40%;border-radius:4px;
                background:linear-gradient(90deg,rgba(74,143,212,0),#4a8fd4,rgba(74,143,212,0));
                animation:slide 1.3s cubic-bezier(.4,0,.2,1) infinite}
    @keyframes slide{0%{left:-40%}100%{left:100%}}
    .thinktxt{font-size:11px;color:#7b8aa0;margin-top:7px;text-align:center;animation:pulse 1.5s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
    .thinktxt::after{content:'';animation:dots 1.4s steps(4,end) infinite}
    @keyframes dots{0%{content:''}25%{content:'·'}50%{content:'··'}75%{content:'···'}}
    /* ★ 回炉重造：与「正在思考」区分开的暖色动画（两条反向滑动条 + 跳动火苗 + 进度点） */
    .think.fix .thinkbar{background:#fdeee2}
    .think.fix .thinkbar i{background:linear-gradient(90deg,rgba(232,138,60,0),#e88a3c,rgba(232,138,60,0));
                           animation:slide 1.1s cubic-bezier(.4,0,.2,1) infinite}
    .think.fix .thinkbar::after{content:'';position:absolute;top:0;bottom:0;right:-40%;width:40%;border-radius:4px;
      background:linear-gradient(90deg,rgba(214,86,86,0),#d65656,rgba(214,86,86,0));
      animation:slideright 1.7s cubic-bezier(.4,0,.2,1) infinite}
    @keyframes slideright{0%{right:-40%}100%{right:100%}}
    .think.fix .thinktxt{color:#b06a34}
    .think.fix .thinktxt::before{content:'🔥';display:inline-block;margin-right:5px;
      animation:fanfire 1.2s ease-in-out infinite}
    @keyframes fanfire{0%{transform:rotate(-14deg) scale(1)}50%{transform:rotate(14deg) scale(1.22)}100%{transform:rotate(-14deg) scale(1)}}
    .think.fix .thinksteps{margin-top:6px;text-align:center;font-size:10.5px;color:#c08a5a;letter-spacing:.5px}
    .think.fix .thinksteps b{display:inline-block;width:6px;height:6px;border-radius:50%;background:#e8a86c;
      margin:0 2px;animation:pulse 1.2s ease-in-out infinite}
    .think.fix .thinksteps b:nth-child(2){animation-delay:.2s}
    .think.fix .thinksteps b:nth-child(3){animation-delay:.4s}
    /* ★ 「还活着」的可见证据：跳动的秒数 + 心跳点 + 进度条 + 阶段文案 + 后台降频警告 */
    .progline{height:4px;border-radius:3px;background:#e9eff7;overflow:hidden;margin:10px 0 7px}
    .progline b{display:block;height:100%;width:0;border-radius:3px;
                background:linear-gradient(90deg,#6fb1ea,#3d76b0);transition:width .9s linear}
    .progline.fix b{background:linear-gradient(90deg,#f0a45c,#d65656)}
    .live{font-size:11px;color:#5b6b80;text-align:center;line-height:1.6}
    .live b{color:#3d76b0;font-variant-numeric:tabular-nums}
    .live .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#38b06b;
               margin-right:5px;vertical-align:1px;animation:beat 1.4s ease-out infinite}
    @keyframes beat{0%{box-shadow:0 0 0 0 rgba(56,176,107,.55)}70%{box-shadow:0 0 0 7px rgba(56,176,107,0)}
                    100%{box-shadow:0 0 0 0 rgba(56,176,107,0)}}
    .live.esc .dot{background:#e8873c}
    .warnline{font-size:10.5px;color:#b4721f;background:#fff8ea;border:1px solid #f2e0bb;border-radius:7px;
              padding:5px 7px;margin-top:8px;line-height:1.55;text-align:left}
    .scard{border-radius:12px;padding:15px 12px;text-align:center;border:1px dashed #cfdced;background:#f7fafd;
           animation:pop .38s cubic-bezier(.34,1.28,.64,1) both}
    @keyframes pop{0%{opacity:0;transform:translateY(10px) scale(.94)}60%{opacity:1;transform:translateY(-2px) scale(1.015)}100%{opacity:1;transform:none}}
    .scard .snum{font-size:44px;font-weight:800;line-height:1.1;letter-spacing:-1px;color:#3d76b0}
    .scard .snum small{font-size:15px;font-weight:600;margin-left:3px;opacity:.65}
    .scard .smsg{font-size:12px;margin-top:7px;color:#5b6b80;line-height:1.6}
    .scard .stag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:1px;
                 padding:2px 9px;border-radius:20px;margin-bottom:6px;background:#e8f0fa;color:#3d76b0}
    .scard.good{background:#eefaf3;border-color:#a9e0c4}
    .scard.good .stag{background:#d9f2e5;color:#0f9d58}
    .scard.good .snum{color:#0f9d58}
    .scard.mid{background:#fff9e8;border-color:#f0dba1}
    .scard.mid .stag{background:#fdf0d0;color:#a97a00}
    .scard.mid .snum{color:#c98a00}
    .scard.low{background:#fdf1ef;border-color:#f2cfc8}
    .scard.low .stag{background:#fadbd5;color:#c0392b}
    .scard.low .snum{color:#c0392b}
    .retry{width:100%;margin-top:8px;color:#fff;border:0;font-size:13.5px}
    .retry.rb{background:#3d76b0}
    .retry.ry{background:#d99a1c}
    .retry.rr{background:#c0392b}
    .retry.rk{background:#1b1b1b}
    .retry:hover{filter:brightness(1.08)}
    .list{max-height:236px;overflow:auto;margin:2px 0}
    .item{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;font-size:12px;
          cursor:pointer;line-height:1.5;color:#2b3d55}
    .item:hover{background:#f2f7fd}
    .item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .item.done .nm{color:#a9b6c6;text-decoration:line-through}
    .item .ck{flex:0 0 auto;font-size:11px}
    .countdown{border:1px solid #f2cfc8;background:#fdf1ef;border-radius:10px;padding:12px;
               text-align:center;color:#c0392b;font-size:13px;font-weight:700;line-height:1.8}
    .countdown b{display:block;font-size:26px;margin-top:4px}
  `;

  const TAG_MAP = { landing: '考试入口', fill: 'AI 答题', grab: '成绩' };

  /* ★ 面板位置常驻：拖完就存，之后每次载入/重绘都回到原位
   *  以前 buildUI() 每次都写死 right:20px;bottom:20px → 页面一变、面板一重绘就弹回右下角，
   *  用户拖好的位置根本留不住。这里存「左上角绝对坐标」并在重建时套回去（超界会夹回可视区）。 */
  function savePanelPos() {
    const cur = document.querySelector('#ouchn-ai-host');
    if (!cur || !cur.getBoundingClientRect) return;
    try {
      const r = cur.getBoundingClientRect();
      if (!r.width) return;
      localStorage.setItem(STORE_POS, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    } catch (e) {}
  }
  function applyPanelPos(host) {
    try {
      const p = JSON.parse(localStorage.getItem(STORE_POS) || 'null');
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;   // 没拖过 → 保持默认右下角锚定
      const maxX = Math.max(8, window.innerWidth - 90);                       // 至少留 90px 在屏内，别拖丢
      const maxY = Math.max(8, window.innerHeight - 44);
      host.style.right = 'auto'; host.style.bottom = 'auto';
      host.style.left = Math.max(0, Math.min(p.x, maxX)) + 'px';
      host.style.top = Math.max(0, Math.min(p.y, maxY)) + 'px';
    } catch (e) {}
  }
  function buildUI() {
    const old = document.querySelector('#ouchn-ai-host');
    if (old) old.remove();
    const page = detectPage();
    if (page === 'course' && !scanActivities().length) {   // 课程页没有任务行就不挂面板
      ui.root = null; ui.res = null; ui.status = null; return;
    }
    const s = loadState();
    const running = !!s.run;
    ui.settingsOpen = ui.settingsOpen || false;

    const host = document.createElement('div');
    host.id = 'ouchn-ai-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:20px;bottom:20px;';
    applyPanelPos(host);            // ★ 拖过就回到用户拖的位置（没拖过 = 保持右下角）
    const root = host.attachShadow({ mode: 'open' });

    try {
      const sn = JSON.parse(localStorage.getItem('ouchn_ai_notice_v1') || 'null');
      if (sn && sn.msg && Date.now() - sn.ts < 120000) {
        localStorage.removeItem('ouchn_ai_notice_v1');
        ui.notice = sn.msg; ui.noticeCls = sn.cls || 'bad';
      }
    } catch (e) {}
    let body = '';
    const noticeHTML = ui.notice ? `<div class="${ui.noticeCls || 'bad'}" style="margin-bottom:9px">${ui.notice}</div>` : '';

    if (ui.settingsOpen) {
      const ap = loadAPI();
      body = `<div class="bd">
                ${noticeHTML}
                <div class="stat">设置</div>
                <div class="setrow"><span style="flex:0 0 46px">接口</span><input id="s_api" style="flex:1;width:auto" placeholder="https://api.xiaomimimo.com/v1" value="${esc(ap.base)}"></div>
                <div class="setrow" style="margin-top:-4px"><span style="flex:0 0 46px">密钥</span><input id="s_key" type="password" style="flex:1;width:auto" placeholder="未设置，输入后点保存" value="${ap.key ? KEY_MASK : ''}"></div>
                <div class="setrow" style="margin-top:-4px"><span style="flex:0 0 46px">模型</span><input id="s_model" style="flex:1;width:auto" placeholder="${API_DEFAULT_MODEL}" value="${esc(ap.model)}"></div>
                <div class="row" style="margin-top:6px">
                  <button class="primary" id="s_save" style="flex:1">保存</button>
                  <button class="ghost" id="s_test" style="flex:0 0 92px">测试连接</button>
                  <button class="ghost" id="s_close" style="flex:0 0 62px">返回</button>
                </div>
                <div class="result" id="s_res"></div>
                <div class="setrow" style="margin-top:2px"><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="s_loose" style="width:auto" ${looseSubmitOn() ? 'checked' : ''}> 简答/匹配/完形没填上也交卷（宽松）</label></div>
                <div class="hint">接口填 OpenAI 兼容地址（一般以 <b>/v1</b> 结尾）；密钥星号遮蔽，真实密钥只存在本机 Tampermonkey 存储。</div>
                <div class="ft">v${VER} · 设置</div>
              </div>`;
    } else if (page === 'course') {
      const acts = scanActivities();
      const doneN = acts.filter(a => a.done).length;
      const bb = loadBatch();
      const todo = acts.filter(a => BATCH_RE.test(a.name) && !a.done && !a.locked).length;
      body = `<div class="bd">
                ${noticeHTML}
                <div class="stat">形考任务</div>
                <div class="hint" style="margin:0 0 8px">共 ${acts.length} 项 ｜ <b class="ok">已完成 ${doneN}</b> ｜ <b class="bad">未完成 ${acts.length - doneN}</b> ｜ 可一键：${todo} 场</div>
                <button class="aibeta" id="batchbtn">${bb.active ? '⏹ 停止批量（' + bb.idx + '/' + bb.queue.length + '）' : '一键全部考试'}</button>
                <div class="hint" style="margin:7px 0 8px">只跑「测试 | 形考任务」系列未完成场次：逐场 AI 答 → 全中交卷 → 读分 → 下一场。</div>
                <div class="list" id="task-list"></div>
                <div class="row" style="margin-top:9px">
                  <button class="ghost" id="rescan" style="flex:1">刷新</button>
                </div>
                <div class="result on" id="res"></div>
                <div class="ft">v${VER} · 形考任务</div>
              </div>`;
    } else if (page === 'landing') {
      body = running
        ? `<div class="bd">
             ${noticeHTML}
             <div class="stat" id="status">运行中…</div>
             <div class="step">当前步骤：${stepLabel(s)}</div>
             <div class="row"><button class="danger" id="stop" style="flex:1">⛔ 急停</button><button class="ghost" id="exit" style="flex:0 0 92px">退出</button></div>
             <div class="ft">v${VER} · AI 自动答题运行中</div>
           </div>`
        : `<div class="bd" style="min-height:210px">
             ${noticeHTML}
             <div class="stat">国开 AI 自动答题</div>
             <button class="aibeta" id="aibeta">AI 自动答题</button>
             <div class="hint" style="margin:9px 0 0">一键到底：AI 答题 → 自动填入 → 全部命中自动交卷 → 成绩卡。<br>中途可急停；失败可一键重试。</div>
             <div class="ft">v${VER} · 纯净版 · 仅供学习研究</div>
           </div>`;
    } else if (page === 'fill') {
      body = running
        ? `<div class="bd">
             ${noticeHTML}
             <div class="stat" id="status">运行中…</div>
             <div class="step">当前步骤：${stepLabel(s)}</div>
             <div class="row"><button class="danger" id="stop" style="flex:1">⛔ 急停</button><button class="ghost" id="exit" style="flex:0 0 92px">退出</button></div>
             <div class="result on" id="res"></div>
             <div class="ft">v${VER} · AI 自动答题</div>
           </div>`
        : `<div class="bd" style="min-height:210px">
             ${noticeHTML}
             <div class="stat">国开 AI 自动答题</div>
             <button class="aibeta" id="aibeta">AI 自动答题</button>
             <div class="hint" style="margin:9px 0 0">一键到底：AI 答题 → 自动填入 → 全部命中自动交卷 → 成绩卡。<br>中途可急停；失败可一键重试。</div>
             <div class="result on" id="res"></div>
             <div class="ft">v${VER} · 纯净版</div>
           </div>`;
    } else if (!page) {
      // 兜底面板：页面状态不认（跳转中/新题型/新页面）也不能让按键消失
      body = `<div class="bd">
                ${noticeHTML}
                <div class="stat">未识别的页面</div>
                <div class="hint" style="margin:0 0 9px">当前页面状态脚本不认（可能正在跳转，或出现了新题型/新页面）。可以退出回到上一页。</div>
                <div class="row">
                  ${running ? '<button class="danger" id="stop" style="flex:1">⛔ 急停</button>' : ''}
                  <button class="ghost" id="exit" style="flex:1">退出（回到上一页）</button>
                </div>
                <div class="ft">v${VER} · 兜底面板</div>
              </div>`;
    } else {
      body = `<div class="bd">
                ${noticeHTML}
                <div class="stat" id="status">正在读取成绩…</div>
                <div class="result on" id="res"></div>
                <div class="ft">v${VER} · 成绩</div>
              </div>`;
    }

    root.innerHTML = `
      <style>${CSS}</style>
      <div class="panel" id="panel">
        <div class="hd" id="hd">
          <div>
            <div class="ttl">国开 AI 自动答题</div>
            <div class="sub">wsQvQ &amp; 蓝色大肥鱼 🥰 纯净版</div>
          </div>
          <div class="grow"></div>
          <span class="tag">${TAG_MAP[page] || ''}</span>
          <div class="ico" id="gear" title="设置">⚙</div>
          <div class="ico" id="diag" title="诊断（把页面实况复制给我）">🔍</div>
          <div class="ico" id="logbtn" title="日志">📜</div>
          <div class="ico" id="tgl" title="折叠">—</div>
        </div>
        ${body}
      </div>`;
    document.body.appendChild(host);

    ui.root = root; ui.page = page;
    ui.res = root.getElementById('res');
    ui.status = root.getElementById('status');

    root.getElementById('gear').addEventListener('click', () => { ui.settingsOpen = !ui.settingsOpen; buildUI(); });
    root.getElementById('tgl').addEventListener('click', () => {
      const c = root.getElementById('panel').classList.toggle('collapsed');
      root.getElementById('tgl').textContent = c ? '＋' : '—';
    });
    root.getElementById('diag').addEventListener('click', () => {
      const rep = diagReport();
      LOGS.push('===== 手动诊断（' + new Date().toLocaleTimeString() + '）=====\n' + rep);
      renderResult(`<div class="sum">诊断报告（点 📜 再复制，或直接全选下面这段）</div><div class="log">${esc(rep)}</div>`);
      log('已生成诊断报告（长度 ' + rep.length + '）');
    });
    root.getElementById('logbtn').addEventListener('click', () => {
      const txt = LOGS.length ? LOGS.slice(-60).join('\n') : '(暂无日志)';
      const extra = `\n\n[状态] ${JSON.stringify(loadState())}\n[页面] ${page}  URL=${location.href}`;
      renderResult(`<div class="sum">运行日志（可复制发我）</div><div class="log">${esc(txt + extra)}</div>`);
    });

    /* 拖动（点图标不拖）；拖完把位置存下来，之后一直常驻在那儿 */
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const hd = root.getElementById('hd');
    hd.addEventListener('pointerdown', e => {
      if (e.target.closest && e.target.closest('.ico')) return;
      dragging = true; moved = false;
      const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      host.style.right = 'auto'; host.style.bottom = 'auto';
      host.style.left = ox + 'px'; host.style.top = oy + 'px';
      hd.setPointerCapture(e.pointerId);
    });
    hd.addEventListener('pointermove', e => {
      if (!dragging) return;
      moved = true;
      host.style.left = Math.max(0, Math.min(ox + e.clientX - sx, window.innerWidth - 90)) + 'px';
      host.style.top = Math.max(0, Math.min(oy + e.clientY - sy, window.innerHeight - 44)) + 'px';
    });
    hd.addEventListener('pointerup', () => {
      dragging = false;
      if (moved) { moved = false; savePanelPos(); }
    });

    /* 急停：连模型请求一起掐 */
    const stop = root.getElementById('stop');
    if (stop) stop.addEventListener('click', () => {
      abortAI();
      const bb = loadBatch(); if (bb.active) { bb.active = false; saveBatch(bb); }
      resetState(); doneKeys.clear(); ui.notice = ''; buildUI();
      log('已急停');
    });

    /* 退出：掐掉在飞的请求，回到上一页 */
    const exit = root.getElementById('exit');
    if (exit) exit.addEventListener('click', () => {
      abortAI();
      log('退出：回到上一页');
      history.back();
    });

    /* AI 启动 / 重试 */
    const aibeta = root.getElementById('aibeta');
    if (aibeta) aibeta.addEventListener('click', () => startAI());

    /* ★ 宽松填入按钮：它是在失败报告里「后插」进来的，用委托点击（buildUI 每次都重建宿主，不会重复绑定） */
    root.addEventListener('click', e => {
      const t = e.target;
      if (t && t.id === 'loosebtn') { e.preventDefault(); looseFill(); }
    });

    /* 设置面板 */
    if (ui.settingsOpen) {
      const keyInput = root.getElementById('s_key');
      if (keyInput) keyInput.addEventListener('focus', () => { if (keyInput.value === KEY_MASK) keyInput.select(); });
      const looseToggle = root.getElementById('s_loose');
      if (looseToggle) looseToggle.addEventListener('change', () => {
        GM_setValue('looseSubmit', !!looseToggle.checked);
        log('宽松交卷：', looseToggle.checked ? '开' : '关', '（立即生效）');
      });
      const sSave = root.getElementById('s_save');
      if (sSave) sSave.addEventListener('click', () => {
        const keyVal = ((root.getElementById('s_key') || {}).value || '').trim();
        const apiO = {
          apiBase:  (root.getElementById('s_api') || {}).value || '',
          apiModel: (root.getElementById('s_model') || {}).value || '',
        };
        if (keyVal && keyVal !== KEY_MASK) apiO.apiKey = keyVal;
        saveAPI(apiO);
        const res = root.getElementById('s_res');
        if (res) { res.innerHTML = '<div class="ok">已保存到本机</div>'; res.classList.add('on'); }
        log('设置已保存');
      });
      const sTest = root.getElementById('s_test');
      if (sTest) sTest.addEventListener('click', async () => {
        const res = root.getElementById('s_res');
        const show = html => { if (res) { res.innerHTML = html; res.classList.add('on'); } };
        const keyRaw = ((root.getElementById('s_key') || {}).value || '').trim();
        const cfg = {
          base:  ((root.getElementById('s_api') || {}).value || '').trim() || API_DEFAULT_BASE,
          key:   (keyRaw && keyRaw !== KEY_MASK) ? keyRaw : (loadAPI().key || ''),
          model: ((root.getElementById('s_model') || {}).value || '').trim() || API_DEFAULT_MODEL,
        };
        if (!cfg.base.trim() || !cfg.key.trim()) { show('<div class="bad">先填接口地址和密钥</div>'); return; }
        sTest.disabled = true; sTest.textContent = '测试中…';
        const t0 = Date.now();
        // 宽松快测：限 8 个 token，有输出就算可用
        const r = await callAI('hi', cfg, 30000, { maxTokens: 8, loose: true });
        sTest.disabled = false; sTest.textContent = '测试连接';
        show(r.ok
          ? `<div class="ok">连接正常（${Date.now() - t0}ms）<br>${r.text.trim() ? '模型回复：' + esc(r.text.trim().slice(0, 40)) : '接口已连通'}</div>`
          : `<div class="bad">连接失败：${esc(r.err)}</div>`);
      });
      const sClose = root.getElementById('s_close');
      if (sClose) sClose.addEventListener('click', () => { ui.settingsOpen = false; buildUI(); });
    }

    /* 课程页：形考任务完成面板（简洁版） */
    if (page === 'course') {
      const list = root.getElementById('task-list');
      const paint = () => {
        const acts = scanActivities();
        if (!list) return;
        list.innerHTML = acts.slice(0, 60).map((a, i) => `
          <div class="item ${a.done ? 'done' : ''}" data-i="${i}">
            <span class="nm">${esc(a.name)}</span>
            <span class="ck">${a.done ? '✅' : '⬜'}</span>
          </div>`).join('');
        list.querySelectorAll('.item').forEach(node => {
          node.addEventListener('click', () => {
            const a = acts[Number(node.dataset.i)];
            if (!a) return;
            try { (clickableAncestor(a.target) || a.target).click(); } catch (e) { log('跳转失败', String(e)); }
          });
        });
      };
      ui.repaint = paint;
      paint();
      const rescan = root.getElementById('rescan');
      if (rescan) rescan.addEventListener('click', () => { paint(); log('重新扫描完成'); });
      const batchbtn = root.getElementById('batchbtn');
      if (batchbtn) batchbtn.addEventListener('click', () => {
        if (loadBatch().active) stopBatch();
        else startBatch();
      });
    }

    /* 成绩页：直接上成绩卡 */
    if (page === 'grab') {
      if (!s.batch && (s.step === 'done' || scanScore() !== '')) scheduleScoreCard();
    }
  }

  /* ==================== 成绩卡 ==================== */
  function scheduleScoreCard() {
    if (ui.scoreTimer || ui.scoreShown) return;
    ui.scoreTimer = true;
    log('检测到分数，准备弹出成绩卡');
    setTimeout(() => showScoreCard(), 2000);
    setTimeout(() => showScoreCard(), 5000);
  }

  function showScoreCard() {
    const hostEl = document.querySelector('#ouchn-ai-host');
    const root = (hostEl && hostEl.shadowRoot) || ui.root;
    const box = root && root.getElementById('res');
    if (!box) { ui.scoreTimer = false; return; }   // 渲染没就位：允许重新排期
    const score = scanScore();
    const st = loadState();
    const course = courseUrlFrom(st.entryUrl || location.href);
    ui.scoreShown = true;

    const num  = score === '' ? null : Number(score);
    const tier = scoreTier(num);
    const say  = tier.pool ? pickMsg(tier.pool) : tier.tip;

    box.innerHTML = `
      <div class="scard ${tier.cls}">
        <div class="stag">${tier.label}</div>
        <div class="snum"><span id="snumv">${score === '' ? '—' : '0'}</span><small>分</small></div>
        <div class="smsg">${say}</div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="again">再考一次</button>
        <button class="ghost" id="other" style="flex:1">回到首页</button>
      </div>
      <button class="retry ${num === null ? 'rb' : num >= 85 ? 'rb' : num >= 75 ? 'ry' : num >= 50 ? 'rr' : 'rk'}" id="retry">让 AI 重新作答</button>
      ${num !== null && num < 50 ? '<div class="hint" style="color:#c0392b;text-align:center;margin:8px 0 0">可能为未收录题型，请立即联系开发者</div>' : ''}
      ${localStorage.getItem(STORE_AIPROC) ? '<button class="ghost" id="aiproc" style="width:100%;margin-top:8px">查看 AI 思考与回答过程</button><div class="log" id="aibox" style="display:none;margin-top:8px"></div>' : ''}`;
    box.classList.add('on');
    box.style.maxHeight = 'none';    // 成绩卡完整展示
    box.style.overflow = 'visible';

    /* 分数滚上去 */
    const snumv = box.querySelector('#snumv');
    if (snumv && num !== null) {
      const t0 = Date.now(), dur = 700;
      const tickNum = () => {
        const k = Math.min(1, (Date.now() - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        snumv.textContent = String(Math.round(num * e));
        if (k < 1) requestAnimationFrame(tickNum); else snumv.textContent = String(num);
      };
      tickNum();
    }

    const again = box.querySelector('#again');
    if (again) again.addEventListener('click', () => {
      const target = retryTarget(st);
      log('再考一次：回答题页自动开跑', target);
      doneKeys.clear(); busy = false;
      saveState({ run: true, step: 'entering', entryUrl: target, fillUrl: target, tries: 0, lockUntil: 0, flow: 'ai', bounceTries: 0, bouncedAt: 0 });
      goAnswerPage(target);
    });
    const other = box.querySelector('#other');
    if (other) other.addEventListener('click', () => {
      if (!course) { setStatus(CFG.PREFIX + '没解析出课程地址', 'bad'); return; }
      log('跳转：课程工作台（落地自动进形考任务）');
      patchState({ pendingXingkao: Date.now() });
      location.href = course;
    });
    const retryBtn = box.querySelector('#retry');
    if (retryBtn) retryBtn.addEventListener('click', () => {
      const pr = buildReviewPrompt();
      if (pr && pr.text) { try { localStorage.setItem(STORE_REVIEW, pr.text); } catch (e) {} }
      const target = retryTarget(st);
      if (!target) { setStatus(CFG.PREFIX + '没找到考试入口地址，请从课程页进入考试后再试', 'bad'); return; }
      log('让 AI 重新作答：回答题页', target);
      doneKeys.clear(); busy = false;            // ★ 清掉页内防重入状态，否则回不到答题流程（历史 bug：卡在「AI 答题中」）
      saveState({ run: true, step: 'entering', entryUrl: target, fillUrl: target, tries: 0, lockUntil: 0, flow: 'retry', bounceTries: 0, bouncedAt: 0 });
      goAnswerPage(target);
    });
    const procBtn = box.querySelector('#aiproc');
    if (procBtn) procBtn.addEventListener('click', () => {
      const bx = box.querySelector('#aibox');
      if (!bx) return;
      if (bx.style.display === 'none') {
        let d = null;
        try { d = JSON.parse(localStorage.getItem(STORE_AIPROC) || 'null'); } catch (e) {}
        bx.innerHTML = d
          ? `<div>模型：${esc(d.model || '')} ｜ 用时 ${Math.round((d.ms || 0) / 1000)}s</div>` +
            (d.reasoning ? `<div style="margin-top:6px"><b>AI 思考过程</b></div><div>${esc(String(d.reasoning).slice(0, 4000))}</div>` : '') +
            `<div style="margin-top:6px"><b>AI 原始回答</b></div><div>${esc(String(d.raw || '').slice(0, 4000))}</div>` +
            `<div style="margin-top:6px"><b>实际填入</b></div><div>${esc(String(d.cleaned || '').slice(0, 2000))}</div>`
          : '（没有记录）';
        bx.style.display = 'block';
        procBtn.textContent = '收起 AI 过程';
      } else {
        bx.style.display = 'none';
        procBtn.textContent = '查看 AI 思考与回答过程';
      }
    });
  }

  /* ==================== 一键全部考试（仅「测试 | 形考任务」系列） ==================== */
  let batchBusy = false;
  const BATCH_RE = /^测试\s*\|\s*形考任务/;

  function startBatch() {
    const prev = loadBatch();
    // 有没跑完的进度（含待重考场）→ 续跑，不重新排队
    if (prev.queue && prev.queue.length && prev.idx < prev.queue.length && prev.attempts) {
      prev.active = true;
      saveBatch(prev);
      ui.notice = ''; ui.noticeCls = '';
      log('批量继续：从', prev.retry || prev.queue[prev.idx], '起（已跑', prev.idx, '场）');
      buildUI();
      batchStep();
      return;
    }
    const acts = scanActivities().filter(a => BATCH_RE.test(a.name) && !a.done && !a.locked);
    if (!acts.length) { setNotice(CFG.PREFIX + '没有未完成的形考任务可跑', 'bad'); buildUI(); return; }
    saveBatch({ active: true, queue: acts.map(a => a.name), idx: 0, results: [], attempts: {}, startedAt: Date.now() });
    log('一键全部考试：队列 →', acts.map(a => a.name).join('、'));
    buildUI();
    batchStep();
  }
  function stopBatch() {
    const b = loadBatch();
    b.active = false;
    saveBatch(b);
    setNotice(CFG.PREFIX + `批量已停止（已跑 ${b.results.length} 场，记录见下）`, 'bad');
    log('批量停止');
    buildUI();
  }

  /** 批量推进：在 formal-exam 列表点开队列里的下一场 */
  async function batchStep() {
    if (batchBusy) return;
    const b = loadBatch();
    if (!b.active) return;
    if (loadState().run) return;                            // 一场正跑着就别插队
    if (!/formal-exam/.test(location.hash || '')) return;   // 只在形考任务列表页推进
    batchBusy = true;
    try {
      if (!b.retry && b.idx >= b.queue.length) {
        b.active = false;
        saveBatch(b);
        const sum = b.results.map(r => `${esc(r.title)} → ${esc(r.msg)}`).join('<br>') || '（无记录）';
        setNotice(CFG.PREFIX + `一键全部考试完成（${b.results.length} 场）<br>${sum}`, 'ok');
        buildUI();
        return;
      }
      const title = b.retry || b.queue[b.idx];
      const target = scanActivities().find(a => a.name === title);
      if (!target) {
        if (b.retry) { b.retry = null; saveBatch(b); }
        batchRecord(title, '跳过：列表里没找到');
        buildUI();
        return;
      }
      if (!b.retry && target.done) { batchRecord(title, '跳过：已完成'); buildUI(); return; }
      if (!b.retry && ((b.attempts && b.attempts[title]) || 0) >= 2) { batchRecord(title, '跳过：已达最大重试次数'); buildUI(); return; }
      log(b.retry ? '批量重考：' : '批量开跑：', title);
      saveState({ run: true, step: 'entering', entryUrl: location.href, tries: 0, lockUntil: 0, flow: b.retry ? 'retry' : 'ai', batch: true, batchTitle: title });
      doneKeys.clear(); busy = false;
      buildUI();
      try { (clickableAncestor(target.target) || target.target).click(); } catch (e) { log('点开任务失败', String(e)); }
    } finally { batchBusy = false; }
  }

  /* ==================== 主循环 ==================== */
  let lastPage = null;
  let lastTickErr = '', lastTickErrAt = 0;      // ★ tick 内部异常：同一错误 10 秒内只报一次
  let wdSig = '', wdAt = Date.now();
  /** 卡死看门狗：运行中但长时间没推进，就把现场写进日志（省得只看到「运行中」干等） */
  function watchdog(page) {
    const s = loadState();
    const sig = page + '|' + s.step;
    if (sig !== wdSig) { wdSig = sig; wdAt = Date.now(); return; }
    if (!s.run || busy) { wdAt = Date.now(); return; }        // 有任务在跑就不算卡
    if (Date.now() - wdAt < 9000) return;
    wdAt = Date.now();
    log('看门狗：运行中但 9 秒无动作 → page=' + page + ' step=' + s.step +
        ' 锁=' + (s.lockUntil && s.lockUntil > Date.now() ? Math.ceil((s.lockUntil - Date.now()) / 1000) + 's' : '无') +
        ' 已完成键=[' + [...doneKeys].join(',') + '] busy=' + busy);
  }

  /** 步骤文案（面板渲染和每 tick 刷新共用一份，避免文案对不上状态） */
  function stepLabel(s) {
    return s && s.step === 'fill' ? 'AI 答题中' : s && s.step === 'entering' ? '进入考场' : String((s && s.step) || '');
  }
  async function tick() {
    if (!document.body) return;
    const page = detectPage();
    const host = document.querySelector('#ouchn-ai-host');
    const s = loadState();
    const running = !!s.run;

    /* ★ 面板自我纠偏（用户实测：流程已经停了，面板却还挂着「思考中 已等待 42 秒」一动不动 → 看着就像卡死）
     *  根因：面板只在「页面类型变化」时重绘，流程在同一个页面上停掉时没人重画。
     *  这里只要发现状态不跑了、而界面还留着思考块，就立刻收掉重画一次。 */
    if (!running && (thinkOpt || (ui.status && ui.status.querySelector && ui.status.querySelector('.live')))) {
      stopThink();
      buildUI();
    }

    /* ★ 步骤文案实时跟上（用户实测：实际已经在 AI 答题，面板却还写着「当前步骤：进入考场」——
     *  面板只在「页面类型变化」时重绘，同一个页面上换步骤就没人更新它。这里每 tick 只改这一行文字，代价极低。） */
    try {
      const stepEl = host && host.shadowRoot && host.shadowRoot.querySelector('.step');
      if (stepEl) {
        const want = '当前步骤：' + stepLabel(s);
        if (stepEl.textContent !== want) stepEl.textContent = want;
      }
    } catch (e) {}    /* ★ 成绩卡防闪烁：卡片已经弹出来了，就别再整体重绘面板
     *  （旧行为：页面 hash 再变一次 → buildUI 把卡片冲掉，显示回「正在读取成绩…」→ 5 秒后计时器再画一次卡 = 闪烁重读） */
    if (page !== lastPage || (!host && page !== 'course')) {
      const keepCard = ui.scoreShown && page === 'grab' && !!host;
      lastPage = page;
      if (!keepCard) buildUI();
    } else if (page === 'grab' && !s.batch && !running && !ui.scoreShown && scanScore() !== '') {
      scheduleScoreCard();
    }
    /* 离开成绩页 → 允许下一场重新弹卡 */
    if (page !== 'grab' && (ui.scoreShown || ui.scoreTimer)) { ui.scoreShown = false; ui.scoreTimer = false; }

    /* 课程页（formal-exam 等）：点「回到首页」2 秒后强制点形考任务 + 任务面板刷新 */
    if (page === 'course') {
      const pk = loadState().pendingXingkao;
      if (pk && Date.now() - pk >= 2000) forceXingkao();
      if (!document.querySelector('#ouchn-ai-host') && scanActivities().length) buildUI();
      else if (ui.repaint) ui.repaint();
      if (!loadState().run) batchStep();   // 批量推进（自带防抖与前提检查）
    }

    if (running) { patchState({}); watchdog(page); automation(page); }   // 心跳
  }

  window.addEventListener('hashchange', () => { lastPage = null; setTimeout(tick, 150); });
  /* ★ 心跳：运行中 500ms（更快推进一步/更快发现页面变化），待机 1200ms（省 CPU）
   *   旧版固定 1200ms，是「点了按钮还要等一会儿」的隐形来源之一 */
  (function loop() {
    const delay = loadState().run ? 500 : 1200;
    setTimeout(() => {
      try { tick(); } catch (e) {
        console.warn('[国开AI纯净版]', e);
        /* ★ 异常不许静默吞掉（踩过：被吞掉 → 面板停在最后一帧 → 用户只看到「卡死」，
             只能靠 🖐 猜）。这里把错误直接写到面板上，并存进诊断，同一错误 10 秒内只报一次。 */
        try {
          const msg = (e && e.message) ? e.message : String(e);
          if (lastTickErr !== msg || Date.now() - lastTickErrAt > 10000) {
            lastTickErr = msg; lastTickErrAt = Date.now();
            localStorage.setItem('ouchn_ai_err_v1', JSON.stringify({
              ts: Date.now(), err: '脚本内部异常：' + msg, retry: false,
              stack: String((e && e.stack) || '').slice(0, 500),
            }));
            stopThink();
            ui.notice = CFG.PREFIX + '脚本内部出错了：' + msg + '（点 🔍 复制诊断发我）';
            ui.noticeCls = 'bad';
            buildUI();
          }
        } catch (e2) {}
      }
      loop();
    }, delay);
  })();
  if (document.body) tick(); else setTimeout(tick, 400);
})();