#!/usr/bin/env node
/**
 * 本地网页搜索 — 后端
 *
 * 只做三件事：
 *   1. 用你本机的 DeepSeek 凭据调用 api.deepseek.com 的 Anthropic 兼容 Messages 接口
 *   2. 请求里挂上原生服务端工具 web_search_20250305（和 DSH 内部用的是同一条路）
 *   3. 把回答 + 结构化来源整理成 JSON 交给本地页面渲染
 *
 * 凭据来源优先级：环境变量 DEEPSEEK_API_KEY → ~/.dsh/.credentials.yaml
 * 没有任何网络代理、不转发到第三方服务，请求直达 DeepSeek。
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);

const BASE_URL = (process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic/v1')
  .replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-v4-flash';
const API_VERSION = process.env.DEEPSEEK_ANTHROPIC_VERSION || '2023-06-01';
const MAX_SHOWN = Math.max(1, Number(process.env.MAX_SHOWN || 10));
const REQUEST_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 180000);
const SEARCH_CONCURRENCY = Math.max(1, Number(process.env.SEARCH_CONCURRENCY || 1));
const SEARCH_STAGGER_MS = Math.max(0, Number(process.env.SEARCH_STAGGER_MS || 250));

/* ---------------------------------------------------------------- 凭据 */

function readCredentialFile() {
  const path = process.env.DSH_CREDENTIALS || join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(path)) return {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  const key = text.match(/^\s*DEEPSEEK_API_KEY:\s*["']?([^"'\s#]+)/m);
  if (key) out.apiKey = key[1];
  const account = text.match(/deepseek-account-platform\/default:[\s\S]*?\n\s*token:\s*["']?([^"'\s#]+)/);
  if (account) out.accountToken = account[1];
  return out;
}

/* ---------------------------------------------------------------- 设置 */

const DATA_DIR = process.env.DSZS_DATA_DIR ? resolve(process.env.DSZS_DATA_DIR) : join(HERE, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  title: 'DeepSeek直搜',
  baseURL: 'https://api.deepseek.com/anthropic/v1',
  model: 'deepseek-v4-flash',
  apiKey: '',
  breadth: 3,
};

function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  s.title = String(s.title || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) || DEFAULT_SETTINGS.title;
  s.baseURL = String(s.baseURL || DEFAULT_SETTINGS.baseURL).trim().replace(/\/+$/, '');
  s.model = String(s.model || DEFAULT_SETTINGS.model).trim().slice(0, 80) || DEFAULT_SETTINGS.model;
  s.apiKey = typeof s.apiKey === 'string' ? s.apiKey.trim() : '';
  s.breadth = [1, 2, 3, 5].includes(Number(s.breadth)) ? Number(s.breadth) : DEFAULT_SETTINGS.breadth;
  return s;
}

function loadSettingsFile() {
  try {
    return normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let appSettings = loadSettingsFile();

function persistSettings(next) {
  appSettings = normalizeSettings(next);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
  } catch (error) {
    throw new ApiError(500, '设置没能写入磁盘', String(error.message || error));
  }
  return appSettings;
}

/**
 * 凭据优先级：页面里配置的 key → 环境变量 → ~/.dsh 凭据文件 → 账号登录态。
 * 每次调用都重新解析，改完设置立刻生效，不用重启。
 */
function resolveAuth() {
  const configured = (appSettings.apiKey || '').trim();
  if (configured) {
    return { mode: 'api-key', apiKey: configured, source: '页面设置里保存的 API Key', headers: apiKeyHeaders(configured) };
  }

  const envKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (envKey) return { mode: 'api-key', apiKey: envKey, source: '环境变量 DEEPSEEK_API_KEY', headers: apiKeyHeaders(envKey) };

  const cred = readCredentialFile();
  if (cred.apiKey) {
    return {
      mode: 'api-key',
      apiKey: cred.apiKey,
      source: '~/.dsh/.credentials.yaml → refs.DEEPSEEK_API_KEY',
      headers: apiKeyHeaders(cred.apiKey),
    };
  }
  if (cred.accountToken) {
    return {
      mode: 'account',
      source: '~/.dsh/.credentials.yaml → DeepSeek 账号登录态',
      headers: { 'x-dsh-auth-token': cred.accountToken },
    };
  }
  return null;
}

function apiKeyHeaders(key) {
  return { 'x-api-key': key, authorization: `Bearer ${key}` };
}

/** 给前端看的设置：绝不返回完整 key，只给末四位。 */
function publicSettings() {
  const auth = resolveAuth();
  return {
    title: appSettings.title,
    baseURL: appSettings.baseURL,
    model: appSettings.model,
    breadth: appSettings.breadth,
    hasKey: Boolean(auth),
    keyTail: auth && auth.apiKey ? auth.apiKey.slice(-4) : '',
    authMode: auth ? auth.mode : null,
    authSource: auth ? auth.source : null,
  };
}

/* ---------------------------------------------------------------- 搜索 */

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function buildMessages(query, maxTokens, maxUses) {
  return {
    model: appSettings.model,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
      },
    ],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
  };
}

async function callMessages(body) {
  const auth = resolveAuth();
  if (!auth) {
    throw new ApiError(500, '还没有配置 DeepSeek API Key', '点左上角「编辑」，填入你自己的 key 再试。');
  }
  const headers = {
    ...auth.headers,
    'anthropic-version': API_VERSION,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'dsh-local-websearch/1.0',
  };
  const endpoint = `${appSettings.baseURL}/messages`;

  // 连接偶尔会被对端重置（ECONNRESET）；重开一条连接重试一次即可，不改变请求语义。
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { status, text } = await postJson(endpoint, headers, body);
      return handleResponse(status, text);
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error)) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2.5, attempt) + Math.random() * 250));
    }
  }

  if (lastError?.message === 'timeout') {
    throw new ApiError(504, `检索超时（>${Math.round(REQUEST_TIMEOUT_MS / 1000)}s）`, '可以少选几次搜索，或换个更短的问题。');
  }
  const cause = lastError?.code || lastError?.cause?.code || lastError?.message || '';
  throw new ApiError(502, `无法连接 DeepSeek：${lastError?.message || '未知网络错误'}`, cause || null);
}

function isRetryableNetworkError(error) {
  // handleResponse 抛出的 ApiError 属于接口语义错误（401/402/429…），重试没有意义；
  // 其它（TLS 断开、连接被重置、DNS 抖动）都是一次性网络问题，重开连接再试一次。
  return !(error instanceof ApiError);
}

/** 用 node:https 发请求：不走 undici 连接池，避免 keep-alive 连接被对端重置。 */
function postJson(endpoint, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? httpsRequest : httpRequest;
    const payload = JSON.stringify(body);

    const req = client(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function handleResponse(status, raw) {
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* 交给下面的统一报错 */
  }

  if (status < 200 || status >= 300) {
    const detail =
      json?.error?.message ?? (typeof json?.error === 'string' ? json.error : null) ?? raw.slice(0, 400);
    const hint =
      status === 401
        ? '凭据被拒绝：检查 API key 是否有效，或改用账号登录态。'
        : status === 429
          ? '触发限流：稍后重试或降低搜索次数。'
          : status === 402
            ? '余额不足：请充值后重试。'
            : null;
    throw new ApiError(status, `DeepSeek 返回 HTTP ${status}${hint ? ` — ${hint}` : ''}`, detail);
  }
  if (!json) throw new ApiError(502, 'DeepSeek 返回了无法解析的响应体', raw.slice(0, 400));
  return json;
}

/** 把 Messages 响应摊平成“回答 + 去重来源 + 计数”。 */
function parseResponse(json, maxShown) {
  const blocks = Array.isArray(json.content) ? json.content : [];
  const queries = [];
  const rawItems = [];
  let lastResultIndex = -1;

  blocks.forEach((block, index) => {
    if (block.type === 'server_tool_use' && block.name === 'web_search') {
      const q = block.input?.query;
      if (typeof q === 'string' && q.trim() && !queries.includes(q.trim())) queries.push(q.trim());
    }
    if (block.type === 'web_search_tool_result') {
      lastResultIndex = index;
      for (const item of Array.isArray(block.content) ? block.content : []) {
        if (item.type === 'web_search_result' && typeof item.url === 'string' && item.url) rawItems.push(item);
      }
    }
  });

  // 摘要片段在 text 块的 citations 里，按 url 首次出现取值
  const cited = new Map();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const cite of Array.isArray(block.citations) ? block.citations : []) {
      if (!cite?.url || !cite?.cited_text) continue;
      if (!cited.has(cite.url)) cited.set(cite.url, cite.cited_text);
    }
  }

  const seen = new Set();
  const sources = [];
  for (const item of rawItems) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    sources.push({
      url: item.url,
      title: (typeof item.title === 'string' && item.title.trim()) || hostOf(item.url),
      snippet: trim((cited.get(item.url) || '').replace(/\s+/g, ' ').trim(), 260),
      publishedAt: typeof item.page_age === 'string' ? item.page_age : '',
    });
  }

  // 回答 = 最后一次检索结果之后的 text 块（之前的通常是“我来搜一下”这类铺垫）
  const answerBlocks = lastResultIndex >= 0 ? blocks.slice(lastResultIndex + 1) : blocks;
  let answer = textOf(answerBlocks);
  if (!answer) answer = textOf(blocks);

  const usage = json.usage || {};
  const searches = Number(usage.server_tool_use?.web_search_requests ?? queries.length ?? 0);

  return {
    answer,
    queries,
    sources,
    total: sources.length,
    shown: Math.min(sources.length, maxShown),
    hidden: Math.max(0, sources.length - maxShown),
    searches,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    },
    stopReason: json.stop_reason ?? null,
    truncated: json.stop_reason === 'max_tokens',
    model: json.model || MODEL,
  };
}

function textOf(blocks) {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * 极端情况：模型只搜不答。补一轮不带工具的对话，让它基于已有结果作总结，
 * 而不是把“只有链接没有结论”的页面丢给用户。
 */
async function summarize(previousBlocks, maxTokens) {
  const body = {
    model: MODEL,
    max_tokens: Math.min(maxTokens, 2048),
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Perform a web search for the query: (continued)' }],
      },
      { role: 'assistant', content: previousBlocks },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请仅基于上面检索到的来源，用中文给出简洁、准确的总结；不确定的地方明确说明。不要编造来源里没有的信息。',
          },
        ],
      },
    ],
  };
  const json = await callMessages(body);
  return { answer: textOf(Array.isArray(json.content) ? json.content : []), usage: json.usage || {} };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function trim(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/**
 * 让模型把一个问题拆成几个“角度不同”的检索式，用来扩大候选池。
 * 只输出 JSON 数组；失败就退回模板，不让它影响主流程。
 */
async function planQueries(query, count) {
  const body = {
    model: MODEL,
    max_tokens: 300,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `检索需求：${query}\n\n` +
              `请给出 ${count} 个补充检索式：与上面的需求相关，但切入角度不同（例如不同主体、时间、数据、英文检索式）。` +
              '只输出一个 JSON 字符串数组，例如 ["...","..."]，不要任何解释。',
          },
        ],
      },
    ],
  };

  const json = await callMessages(body);
  const text = textOf(Array.isArray(json.content) ? json.content : []);
  const match = text.match(/\[[\s\S]*?\]/);
  let list = [];
  try {
    const parsed = JSON.parse(match ? match[0] : '');
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    /* 退回模板 */
  }

  const cleaned = list
    .filter((q) => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length >= 2 && q.length <= 200 && q !== query);

  return unique(cleaned).slice(0, count);
}

/** 规划失败时的兜底检索式（覆盖最新进展、分析数据、官方说明三个常见补充面）。 */
function fallbackQueries(query, count) {
  return [
    `${query} 最新进展`,
    `${query} 分析 数据`,
    `${query} 官方 说明`,
  ].slice(0, count);
}

/**
 * 以固定并发度跑一组异步任务，返回 Promise.allSettled 形状的结果。
 * 同时开太多 TLS 连接容易被对端重置，这里默认只开 2 条。
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    let started = 0;
    for (let index = cursor++; index < items.length; index = cursor++) {
      // 连续握手太密容易被对端断开，起新连接之间稍微间隔一下
      if (started++ > 0 && SEARCH_STAGGER_MS > 0) {
        await new Promise((r) => setTimeout(r, SEARCH_STAGGER_MS));
      }
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

async function runSearch(payload) {
  if (!resolveAuth()) {
    throw new ApiError(
      500,
      '还没有配置 DeepSeek API Key',
      '点页面左上角的标题（或「编辑」），填入你自己的 key 后保存即可，无需重启。',
    );
  }

  const query = String(payload.query ?? '').trim();
  if (!query) throw new ApiError(400, '查询内容不能为空', null);
  if (query.length > 500) throw new ApiError(400, '查询过长（上限 500 字）', null);

  const breadth = clampInt(payload.maxUses, 1, 5, 3);
  const maxTokens = clampInt(payload.maxTokens, 512, 8192, 4096);
  const started = Date.now();

  // 1) 规划补充检索式（仅广度 > 1 时需要）
  let planned = [];
  if (breadth > 1) {
    try {
      planned = await planQueries(query, breadth - 1);
    } catch {
      planned = [];
    }
    if (planned.length < breadth - 1) {
      planned = unique([...planned, ...fallbackQueries(query, breadth - 1)]).slice(0, breadth - 1);
    }
  }
  const queries = [query, ...planned].slice(0, breadth);

  // 2) 并行检索：每个检索式各自一轮带 web_search 的对话（max_uses 固定 1，便于计数）
  const settled = await mapWithConcurrency(queries, SEARCH_CONCURRENCY, (q) =>
    callMessages(buildMessages(q, maxTokens, 1)),
  );

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const sources = [];
  const seen = new Set();
  const usedQueries = [];
  const failures = [];
  let answer = '';
  let truncated = false;
  let model = MODEL;
  let firstBlocks = null;

  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      failures.push({ query: queries[index], message: outcome.reason?.message ?? '失败' });
      return;
    }
    const json = outcome.value;
    const parsed = parseResponse(json, MAX_SHOWN);
    usedQueries.push(...parsed.queries);
    for (const source of parsed.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
    }
    usage.inputTokens += parsed.usage.inputTokens;
    usage.outputTokens += parsed.usage.outputTokens;
    usage.cacheReadTokens += parsed.usage.cacheReadTokens;
    if (index === 0) {
      answer = parsed.answer;
      truncated = parsed.truncated;
      model = parsed.model;
      firstBlocks = Array.isArray(json.content) ? json.content : null;
    }
  });

  if (!sources.length) {
    const rejected = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
    if (rejected.length === settled.length) {
      // 全部失败：把真正的失败原因（网络/凭据/限流）原样抛给前端，别伪装成“没结果”
      throw rejected[0] instanceof ApiError
        ? rejected[0]
        : new ApiError(502, `检索失败：${rejected[0]?.message ?? '未知错误'}`, null);
    }
    throw new ApiError(502, '模型这次没有触发检索，没有拿到来源', '换个更具体的问法，或降低检索广度再试。');
  }

  // 3) 主检索式没给结论时，补一轮总结（不带工具）
  if (!answer && firstBlocks) {
    try {
      const extra = await summarize(firstBlocks, maxTokens);
      if (extra.answer) {
        answer = extra.answer;
        usage.outputTokens += extra.usage.output_tokens ?? 0;
        usage.inputTokens += extra.usage.input_tokens ?? 0;
      }
    } catch {
      /* 兜底失败不影响来源列表 */
    }
  }

  return {
    query,
    answer,
    queries: unique(usedQueries.length ? usedQueries : queries),
    sources,
    total: sources.length,
    shown: Math.min(sources.length, MAX_SHOWN),
    hidden: Math.max(0, sources.length - MAX_SHOWN),
    maxShown: MAX_SHOWN,
    searches: settled.filter((s) => s.status === 'fulfilled').length,
    breadth,
    usage,
    stopReason: null,
    truncated,
    model,
    failures,
    elapsedMs: Date.now() - started,
    searchedAt: new Date().toISOString(),
    authMode: resolveAuth()?.mode ?? null,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}


/* ---------------------------------------------------------------- 历史 / 归档 */

const RESULTS_DIR = join(DATA_DIR, 'results');
const ARCHIVE_DIR = join(DATA_DIR, 'archive');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const ARCHIVE_FILE = join(DATA_DIR, 'archive.json');
const MAX_HISTORY = 60;
const MAX_ARCHIVE = 200;

for (const dir of [DATA_DIR, RESULTS_DIR, ARCHIVE_DIR]) mkdirSync(dir, { recursive: true });

function newId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function assertId(id) {
  if (!/^r[a-z0-9]{6,24}$/.test(String(id || ''))) throw new ApiError(400, '非法的记录 id', null);
  return String(id);
}

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJsonArray(file, list) {
  await writeFile(file, JSON.stringify(list, null, 2));
}

async function readIndex() {
  return {
    history: await readJsonArray(HISTORY_FILE),
    archive: await readJsonArray(ARCHIVE_FILE),
  };
}

/** 每次成功搜索落一条索引 + 一份完整结果 JSON，供侧边栏和历史回看使用。 */
async function recordSearch(result) {
  const id = newId();
  const entry = {
    id,
    query: result.query,
    createdAt: result.searchedAt,
    total: result.total,
    hidden: result.hidden,
    breadth: result.breadth,
    elapsedMs: result.elapsedMs,
  };
  const history = await readJsonArray(HISTORY_FILE);
  history.unshift(entry);
  await writeJsonArray(HISTORY_FILE, history.slice(0, MAX_HISTORY));
  await writeFile(join(RESULTS_DIR, `${id}.json`), JSON.stringify({ ...result, id }, null, 2));
  return id;
}

function resultFileCandidates(id) {
  return [
    { dir: RESULTS_DIR, section: 'history', path: join(RESULTS_DIR, `${id}.json`) },
    { dir: ARCHIVE_DIR, section: 'archive', path: join(ARCHIVE_DIR, `${id}.json`) },
  ];
}

/** 把一条历史移到归档：索引挪位，JSON/HTML 文件也挪到 archive 目录。 */
async function archiveEntry(id) {
  const history = await readJsonArray(HISTORY_FILE);
  const index = history.findIndex((item) => item.id === id);
  if (index < 0) throw new ApiError(404, '这条记录已经不在历史里了', null);

  const [entry] = history.splice(index, 1);
  const archive = await readJsonArray(ARCHIVE_FILE);
  archive.unshift(entry);
  await writeJsonArray(HISTORY_FILE, history);
  await writeJsonArray(ARCHIVE_FILE, archive.slice(0, MAX_ARCHIVE));

  for (const ext of ['json', 'html']) {
    const from = join(RESULTS_DIR, `${id}.${ext}`);
    if (!existsSync(from)) continue;
    const to = join(ARCHIVE_DIR, `${id}.${ext}`);
    if (existsSync(to)) await unlink(to);
    await rename(from, to);
  }
}

async function deleteEntry(id, section) {
  const file = section === 'archive' ? ARCHIVE_FILE : HISTORY_FILE;
  const list = await readJsonArray(file);
  const next = list.filter((item) => item.id !== id);
  await writeJsonArray(file, next);

  const dir = section === 'archive' ? ARCHIVE_DIR : RESULTS_DIR;
  for (const ext of ['json', 'html']) {
    const target = join(dir, `${id}.${ext}`);
    if (existsSync(target)) await unlink(target);
  }
  return list.length !== next.length;
}

async function findResult(id) {
  for (const candidate of resultFileCandidates(id)) {
    if (!existsSync(candidate.path)) continue;
    try {
      return { ...candidate, data: JSON.parse(await readFile(candidate.path, 'utf8')) };
    } catch {
      throw new ApiError(500, '这条记录的文件损坏了', candidate.path);
    }
  }
  return null;
}

function openInFileManager(dir) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(command, [dir], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}


/* ---------------------------------------------------------------- 余额 */

let balanceCache = { at: 0, data: null };

function balanceEndpoint() {
  try {
    return new URL(appSettings.baseURL).origin + '/user/balance';
  } catch {
    return 'https://api.deepseek.com/user/balance';
  }
}

/** 查余额：只支持 API Key 模式；30 秒缓存，避免每次都打接口。 */
async function getBalance(refresh) {
  const auth = resolveAuth();
  if (!auth) return { ok: false, message: '还没有配置 API Key' };
  if (!auth.apiKey) return { ok: false, message: '当前用的是账号登录态，余额请到 DeepSeek 平台查看' };
  if (!refresh && balanceCache.data && Date.now() - balanceCache.at < 30000) return balanceCache.data;

  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !response; attempt++) {
    try {
      response = await httpGetJson(balanceEndpoint(), {
        authorization: `Bearer ${auth.apiKey}`,
        accept: 'application/json',
        'user-agent': 'dsh-local-websearch/1.0',
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (!response) {
    return { ok: false, message: '查余额失败（网络没连上），点「刷新」重试', detail: String(lastError?.message || lastError || '') };
  }

  try {
    const { status, text } = response;
    const json = JSON.parse(text || '{}');

    if (status === 401) return { ok: false, message: 'API Key 被拒绝（401），检查一下 key' };
    if (status !== 200) return { ok: false, message: `余额接口返回 HTTP ${status}`, detail: json?.error?.message ?? null };

    const info = Array.isArray(json.balance_infos) ? json.balance_infos[0] : null;
    const data = {
      ok: true,
      available: Boolean(json.is_available),
      currency: info?.currency || 'CNY',
      total: info?.total_balance ?? null,
      granted: info?.granted_balance ?? null,
      toppedUp: info?.topped_up_balance ?? null,
      keyTail: auth.apiKey.slice(-4),
      checkedAt: new Date().toISOString(),
    };
    balanceCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    return { ok: false, message: '查余额失败：' + (error?.message || error) };
  }
}

function httpGetJson(endpoint, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? httpsRequest : httpRequest;
    const req = client(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.setTimeout(15000, () => {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---------------------------------------------------------------- HTTP */


const PAGE = join(HERE, 'public', 'index.html');

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const auth = resolveAuth();
      sendJson(res, 200, {
        ok: Boolean(auth),
        authMode: auth?.mode ?? null,
        authSource: auth?.source ?? null,
        model: appSettings.model,
        baseURL: appSettings.baseURL,
        maxShown: MAX_SHOWN,
        ...publicSettings(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(res, 200, publicSettings());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      assertSameOrigin(req);
      const payload = await readJsonBody(req);
      const next = { ...appSettings };

      if (payload.title !== undefined) next.title = payload.title;
      if (payload.breadth !== undefined) next.breadth = payload.breadth;

      if (payload.baseURL !== undefined) {
        const raw = String(payload.baseURL).trim().replace(/\/+$/, '');
        let parsed;
        try {
          parsed = new URL(raw);
        } catch {
          throw new ApiError(400, 'API 地址不是合法的 URL', raw);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new ApiError(400, 'API 地址只支持 http / https', raw);
        next.baseURL = raw;
      }

      if (payload.model !== undefined) {
        const model = String(payload.model).trim();
        if (!model || model.length > 80) throw new ApiError(400, '模型名不合法', model);
        next.model = model;
      }

      if (payload.apiKey !== undefined && String(payload.apiKey).trim()) {
        const key = String(payload.apiKey).trim().replace(/\s+/g, '');
        if (key.length < 16 || key.length > 256) throw new ApiError(400, 'API Key 长度不对', null);
        next.apiKey = key;
      }

      persistSettings(next);
      balanceCache = { at: 0, data: null };
      sendJson(res, 200, publicSettings());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/balance') {
      sendJson(res, 200, await getBalance(url.searchParams.get('refresh') === '1'));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/search') {
      assertSameOrigin(req);
      const contentType = String(req.headers['content-type'] || '');
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new ApiError(415, '请求体必须是 application/json', null);
      }
      const raw = await readBody(req, 64 * 1024);
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new ApiError(400, '请求体不是合法 JSON', null);
      }
      const result = await runSearch(payload);
      const id = await recordSearch(result);
      sendJson(res, 200, { ...result, id });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      sendJson(res, 200, await readIndex());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/history/archive') {
      assertSameOrigin(req);
      const payload = await readJsonBody(req);
      await archiveEntry(assertId(payload.id));
      sendJson(res, 200, { ok: true, ...(await readIndex()) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/history/delete') {
      assertSameOrigin(req);
      const payload = await readJsonBody(req);
      const removed = await deleteEntry(assertId(payload.id), payload.section === 'archive' ? 'archive' : 'history');
      sendJson(res, 200, { ok: removed, ...(await readIndex()) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      assertSameOrigin(req);
      const payload = await readJsonBody(req);
      const dir = payload.section === 'history' ? RESULTS_DIR : ARCHIVE_DIR;
      if (!openInFileManager(dir)) throw new ApiError(500, '无法打开文件夹', dir);
      sendJson(res, 200, { ok: true, path: dir });
      return;
    }

    const snapshot = url.pathname.match(/^\/api\/results\/([^/]+)\/snapshot$/);
    if (req.method === 'POST' && snapshot) {
      assertSameOrigin(req);
      const id = assertId(snapshot[1]);
      const found = await findResult(id);
      if (!found) throw new ApiError(404, '这条记录不存在了', null);
      const html = await readBody(req, 8 * 1024 * 1024);
      if (!html.trim()) throw new ApiError(400, '快照内容为空', null);
      await writeFile(join(found.dir, `${id}.html`), html);
      sendJson(res, 200, { ok: true, path: join(found.dir, `${id}.html`) });
      return;
    }

    const result = url.pathname.match(/^\/api\/results\/([^/]+)$/);
    if (req.method === 'GET' && result) {
      const id = assertId(result[1]);
      const found = await findResult(id);
      if (!found) throw new ApiError(404, '记录不存在或已被删除', null);
      sendJson(res, 200, { ...found.data, hasHtml: existsSync(join(found.dir, `${id}.html`)) });
      return;
    }

    const view = url.pathname.match(/^\/view\/([^/]+)$/);
    if (req.method === 'GET' && view) {
      const id = assertId(view[1]);
      for (const dir of [RESULTS_DIR, ARCHIVE_DIR]) {
        const file = join(dir, `${id}.html`);
        if (!existsSync(file)) continue;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(await readFile(file));
        return;
      }
      throw new ApiError(404, '还没有为这一条保存 HTML 快照', null);
    }

    sendJson(res, 404, { error: { message: '未找到该路径' } });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof ApiError ? error.detail : null;
    console.error(`[${new Date().toISOString()}] ${status} ${message}${detail ? ` :: ${detail}` : ''}`);
    sendJson(res, status, { error: { message, detail } });
  }
});

/**
 * 本服务只监听 127.0.0.1，但浏览器里任何一个网页都能向它发请求；
 * 校验 Origin/Host，避免别的站点借你的凭据发起搜索。
 */
function assertSameOrigin(req) {
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiError(403, '跨站请求被拒绝', null);
    }
    if (!allowed.has(originHost)) {
      throw new ApiError(403, '跨站请求被拒绝', '只允许来自本页面（127.0.0.1）的请求。');
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, '请求体必须是 application/json', null);
  }
  const raw = await readBody(req, 64 * 1024);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON', null);
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, '请求体过大', null));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

server.listen(PORT, HOST, () => {
  const where = `http://${HOST}:${PORT}`;
  console.log(`本地搜索已启动: ${where}`);
  console.log(`模型: ${MODEL}   端点: ${BASE_URL}/messages`);
  const bootAuth = resolveAuth();
  console.log(
    bootAuth
      ? `凭据: ${bootAuth.source}（${bootAuth.mode === 'account' ? '账号登录态' : 'API key'}）`
      : '提示: 还没有 API Key — 打开页面后点「编辑」填一个即可',
  );

  if (process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      spawn(opener, [where], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    } catch {
      /* 打不开就算了，手点链接 */
    }
  }
});
