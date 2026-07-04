import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { exec } from 'child_process';
import { requireAuth, signSessionToken } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import multer from 'multer';
import { generateFullPrompt } from './services/promptService.js';
import { generateArticlePrompt, generateArticlePromptWithReferences } from './services/articlePromptService.js';
import { AIModelManager } from './services/aiProviders/AIModelManager.js';
import { generateContentWithFallback } from './services/aiProviders/geminiFallback.js';
import { PromptTemplates } from './services/analysisPrompts/PromptTemplates.js';
import { aggregateChannelData, clearAnalyticsCache } from './services/channelAnalyticsService.js';
import { fetchAllVideoTitles, uploadToGist, searchVideosFromCache, loadFromGist } from './services/videoCacheService.js';
import { getChannelVideosAnalytics, calculateUpdatePriority, getVideoSearchTerms, getVideoExternalTrafficDetails } from './services/analyticsService.js';
import { generateKeywordAnalysisPrompt } from './services/keywordAnalysisPromptService.js';
import { TOOL_DEFINITIONS, executeTool } from './services/analyticsTools.js';
import {
  getQuotaSnapshot as getServerQuotaSnapshot,
  resetQuotaSnapshot as resetServerQuotaSnapshot,
} from './services/quotaTracker.js';
import * as taskQueue from './services/taskQueue.js';
import {
  enableArticleTemplates,
  disableArticleTemplates,
  refreshArticleTemplates,
  getArticleTemplateStatus,
  listAvailableArticleTemplates,
} from './services/articlePromptService.js';
import { publishArticleToNotion, listNotionDatabases, getNotionDatabase } from './services/notionService.js';
import { jsonrepair } from 'jsonrepair';
import { postprocessArticleHtml } from './services/articleHtmlPostprocess.js';

// 載入 .env.local 檔案
dotenv.config({ path: '.env.local' });

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

// 檔案保留天數設定（預設 7 天）
const FILE_RETENTION_DAYS = parseInt(process.env.FILE_RETENTION_DAYS || '7', 10);

// Notion OAuth 狀態儲存（簡易 in-memory）
const notionStateStore = new Map();
const NOTION_STATE_TTL_MS = 5 * 60 * 1000; // 5 分鐘有效

function pruneExpiredNotionStates() {
  const now = Date.now();
  for (const [state, meta] of notionStateStore.entries()) {
    if (now - meta.createdAt > NOTION_STATE_TTL_MS) {
      notionStateStore.delete(state);
    }
  }
}

// 下載速率限制（保護用戶帳號安全）
const downloadRateLimiter = new Map(); // key: userId/token, value: { count, resetTime }
const ipRateLimiter = new Map(); // key: IP address, value: { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 小時
const MAX_DOWNLOADS_PER_HOUR = 10; // 每小時最多 10 次下載（每個帳號）
const MAX_DOWNLOADS_PER_HOUR_PER_IP = 20; // 每小時最多 20 次下載（每個 IP，防止濫用多帳號）
const aiRateLimiter = new Map(); // 貴的 AI / 配額端點限流（每帳號）
const MAX_AI_REQUESTS_PER_HOUR = 60; // ai-chat / keyword-analysis / video-cache generate

function checkRateLimit(identifier, limiterMap, maxDownloads) {
  const now = Date.now();
  const record = limiterMap.get(identifier);

  if (!record || now > record.resetTime) {
    // 新的時間窗口
    limiterMap.set(identifier, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return { allowed: true, remaining: maxDownloads - 1 };
  }

  if (record.count >= maxDownloads) {
    const waitMinutes = Math.ceil((record.resetTime - now) / (60 * 1000));
    return {
      allowed: false,
      remaining: 0,
      waitMinutes
    };
  }

  record.count++;
  return {
    allowed: true,
    remaining: maxDownloads - record.count
  };
}

// 驗證 API Key
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ ERROR: GEMINI_API_KEY is not set in .env.local');
  console.error('Please add GEMINI_API_KEY=your_api_key to .env.local');
  process.exit(1);
}

console.log('✅ Gemini API Key loaded successfully');

// Gemini API HTTP 配置（設置 15 分鐘超時，適合處理長影片）
const GEMINI_HTTP_OPTIONS = {
  timeout: 15 * 60 * 1000  // 15 分鐘（毫秒）
};

// 初始化 Gemini AI 客戶端（用於 Files API 等）
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: GEMINI_HTTP_OPTIONS
});

// 初始化 AI 模型管理器
const aiManager = new AIModelManager();
const DEFAULT_MAX_TOKENS = 8192;
const MODEL_MAX_TOKEN_MAP = {
  'openai/gpt-5.1': 128000,
};

const getMaxTokensForModel = (modelType = '') => {
  if (!modelType) return DEFAULT_MAX_TOKENS;
  return MODEL_MAX_TOKEN_MAP[modelType] || DEFAULT_MAX_TOKENS;
};
console.log('✅ AI Model Manager initialized');

// ==================== CORS ====================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)
  .concat(['http://localhost:3001', 'http://localhost:5173']);

app.use(cors({
  origin: (origin, callback) => {
    // 允許無 origin（curl / Postman / 同源請求）
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
// 安全標頭。停用會干擾跨來源資源/視窗的策略：
// - CSP / COEP / CORP：以免擋掉 gapi、YouTube 縮圖
// - COOP：Google 登入用 popup 回傳 token，same-origin COOP 會切斷 popup↔opener 導致登入卡住
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));
app.use(express.json({ limit: '5mb' }));

// 健康檢查（免驗證，供 CI / 監控使用）
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// 開機檢查 JWT_SECRET 強度（弱密鑰僅警告，不擋啟動）
{
  const s = process.env.JWT_SECRET || '';
  if (!s || s.length < 32 || /dev-secret|change-me/i.test(s)) {
    console.warn('[Security] ⚠️ JWT_SECRET 太弱或未設定，建議改成 ≥32 字元的隨機字串');
  }
}

// ==================== 驗證登入（無需 JWT）====================
/**
 * 用 Google access token 換取 session JWT
 * POST /api/auth/login
 * Body: { accessToken: string }
 */
app.post('/api/auth/login', async (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken) {
    return res.status(400).json({ error: 'MISSING_ACCESS_TOKEN' });
  }

  // 允許的 YouTube channel ID（優先）或 email（備用）
  const allowedChannels = (process.env.ALLOWED_CHANNEL_IDS || '')
    .split(',').map(c => c.trim()).filter(Boolean);
  const allowedEmails = (process.env.ALLOWED_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (allowedChannels.length === 0 && allowedEmails.length === 0) {
    return res.status(403).json({ error: 'ALLOWED_CHANNEL_IDS not configured on server' });
  }

  try {
    // 用 YouTube API 取得頻道 ID（直接驗證 YouTube 身份，不依賴 email）
    if (allowedChannels.length > 0) {
      const chRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!chRes.ok) {
        return res.status(401).json({ error: 'INVALID_YOUTUBE_TOKEN' });
      }
      const chData = await chRes.json();
      const channelId = chData.items?.[0]?.id;
      if (!channelId) {
        return res.status(401).json({ error: 'CANNOT_GET_CHANNEL_ID' });
      }
      if (!allowedChannels.includes(channelId)) {
        console.warn(`[Auth] 拒絕登入：channel ${channelId} 不在白名單`);
        return res.status(403).json({ error: 'CHANNEL_NOT_ALLOWED' });
      }
      const sessionToken = signSessionToken(channelId);
      console.log(`[Auth] 登入成功：channel ${channelId}`);
      return res.json({ sessionToken, channelId });
    }

    // fallback：email 白名單（向下相容）
    const infoRes = await fetch(
      `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!infoRes.ok) {
      return res.status(401).json({ error: 'INVALID_GOOGLE_TOKEN' });
    }
    const info = await infoRes.json();
    const email = (info.email || '').toLowerCase();
    if (!email) {
      return res.status(401).json({ error: 'CANNOT_VERIFY_EMAIL' });
    }
    if (!allowedEmails.includes(email)) {
      console.warn(`[Auth] 拒絕登入：${email} 不在白名單`);
      return res.status(403).json({ error: 'EMAIL_NOT_ALLOWED' });
    }
    const sessionToken = signSessionToken(email);
    console.log(`[Auth] 登入成功：${email}`);
    res.json({ sessionToken, email });
  } catch (err) {
    console.error('[Auth] login error:', err.message);
    res.status(500).json({ error: 'LOGIN_FAILED' });
  }
});

// ==================== 所有 /api/* 路由需要 JWT ====================
app.use('/api', requireAuth);

// 確保下載目錄存在
const DOWNLOAD_DIR = path.join(process.cwd(), 'temp_videos');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// 確保圖片目錄存在
const IMAGES_DIR = path.join(process.cwd(), 'public', 'images');
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// 確保上傳目錄存在（用於 Gemini Files API 暫存）
const UPLOAD_DIR = path.join(process.cwd(), 'temp_uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * 驗證 filePath 只能在允許的目錄內，防止路徑穿越攻擊
 * 回傳 resolved 絕對路徑，不合法時拋出 Error
 */
function validateFilePath(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const allowedDirs = [
    path.resolve(DOWNLOAD_DIR),
    path.resolve(UPLOAD_DIR),
  ];
  const inAllowed = allowedDirs.some(
    dir => resolved === dir || resolved.startsWith(dir + path.sep)
  );
  if (!inAllowed) {
    throw new Error(`Invalid filePath: outside allowed directories`);
  }
  return resolved;
}

// 設定 multer 用於檔案上傳
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB 限制
  }
});

// 靜態檔案服務 - 提供截圖存取
app.use('/images', express.static(IMAGES_DIR));

// 前端執行期設定：由後端輸出 config.js，避免在建置期烘入敏感或會變動的設定
app.get('/app-config.js', (_req, res) => {
  const cfg = {
    YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || null,
    YOUTUBE_SCOPES: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/yt-analytics.readonly',
  };
  res.type('application/javascript').send(`window.__APP_CONFIG__ = ${JSON.stringify(cfg)};`);
});

// Quota debugging endpoints
app.get('/api/quota/server', (_req, res) => {
  try {
    const snapshot = getServerQuotaSnapshot();
    res.json(snapshot);
  } catch (error) {
    console.error('[Quota] Failed to fetch server quota snapshot:', error);
    res.status(500).json({
      error: 'FAILED_TO_FETCH_SERVER_QUOTA',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/quota/server/reset', (_req, res) => {
  try {
    resetServerQuotaSnapshot();
    res.json({ success: true });
  } catch (error) {
    console.error('[Quota] Failed to reset server quota snapshot:', error);
    res.status(500).json({
      error: 'FAILED_TO_RESET_SERVER_QUOTA',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ==================== 任務管理 API ====================

/**
 * 獲取任務狀態
 * GET /api/task/:taskId
 */
app.get('/api/task/:taskId', (req, res) => {
  const { taskId } = req.params;

  const task = taskQueue.getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // 回傳前移除 params 中的敏感欄位，避免 token 洩漏
  const safeTask = { ...task };
  if (safeTask.params) {
    const { accessToken: _t, ...safeParams } = safeTask.params;
    safeTask.params = safeParams;
  }
  res.json(safeTask);
});

/**
 * 刪除/取消任務（任務會在完成後自動清理）
 * DELETE /api/task/:taskId
 */
app.delete('/api/task/:taskId', (req, res) => {
  const { taskId } = req.params;

  const task = taskQueue.getTask(taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // taskQueue 會自動清理已完成的任務，不需要手動刪除
  res.json({
    success: true,
    message: 'Tasks are automatically cleaned up after completion. No manual deletion needed.'
  });
});

// ==================== 模板管理 API ====================

/**
 * 啟用自訂模板
 * POST /api/templates/enable
 */
app.post('/api/templates/enable', async (req, res) => {
  try {
    await enableArticleTemplates();
    const status = getArticleTemplateStatus();
    res.json({
      success: true,
      message: 'Custom templates enabled',
      usingCustomTemplates: status.usingCustomTemplates,
      lastLoadedAt: status.lastLoadedAt
    });
  } catch (error) {
    console.error('[Templates] Enable error:', error);
    res.status(500).json({
      error: 'Failed to enable templates',
      details: error.message
    });
  }
});

/**
 * 停用自訂模板
 * POST /api/templates/disable
 */
app.post('/api/templates/disable', (req, res) => {
  try {
    disableArticleTemplates();
    res.json({ success: true, message: 'Custom templates disabled' });
  } catch (error) {
    console.error('[Templates] Disable error:', error);
    res.status(500).json({
      error: 'Failed to disable templates',
      details: error.message
    });
  }
});

/**
 * 刷新模板
 * POST /api/templates/refresh
 */
app.post('/api/templates/refresh', async (req, res) => {
  try {
    const result = await refreshArticleTemplates();
    res.json({
      success: true,
      message: 'Templates refreshed',
      ...result
    });
  } catch (error) {
    console.error('[Templates] Refresh error:', error);
    res.status(500).json({
      error: 'Failed to refresh templates',
      details: error.message
    });
  }
});

/**
 * 獲取模板狀態
 * GET /api/templates/status
 */
app.get('/api/templates/status', (req, res) => {
  try {
    const status = getArticleTemplateStatus();
    res.json(status);
  } catch (error) {
    console.error('[Templates] Status error:', error);
    res.status(500).json({
      error: 'Failed to get template status',
      details: error.message
    });
  }
});

/**
 * 列出可用模板
 * GET /api/templates
 */
app.get('/api/templates', async (req, res) => {
  try {
    const templates = await listAvailableArticleTemplates();
    const status = getArticleTemplateStatus();
    res.json({
      success: true,
      templates,
      usingCustomTemplates: status.usingCustomTemplates,
      lastLoadedAt: status.lastLoadedAt,
      disabled: status.disabled
    });
  } catch (error) {
    console.error('[Templates] List error:', error);
    res.status(500).json({
      error: 'Failed to list templates',
      details: error.message
    });
  }
});

// ==================== Notion 整合 API ====================

/**
 * 獲取 Notion OAuth URL
 * GET /api/notion/oauth/url
 */
app.get('/api/notion/oauth/url', (req, res) => {
  try {
    const clientId = process.env.NOTION_CLIENT_ID;
    const redirectUri = process.env.NOTION_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      return res.status(400).json({
        error: 'Notion OAuth 尚未設定，請在環境變數加入 NOTION_CLIENT_ID 及 NOTION_REDIRECT_URI。',
      });
    }

    pruneExpiredNotionStates();

    // 透過 query 明確帶入前端來源，避免瀏覽器省略 Origin header 時無法判別
    let requestOrigin = null;
    if (typeof req.query.origin === 'string' && req.query.origin) {
      requestOrigin = req.query.origin;
    } else if (Array.isArray(req.query.origin) && req.query.origin.length > 0) {
      requestOrigin = req.query.origin[0];
    } else if (req.headers.origin) {
      requestOrigin = req.headers.origin;
    }

    const state = crypto.randomBytes(16).toString('hex');
    notionStateStore.set(state, {
      createdAt: Date.now(),
      origin: requestOrigin,
    });

    const notionAuthUrl = new URL('https://api.notion.com/v1/oauth/authorize');
    notionAuthUrl.searchParams.set('response_type', 'code');
    notionAuthUrl.searchParams.set('owner', 'user');
    notionAuthUrl.searchParams.set('client_id', clientId);
    notionAuthUrl.searchParams.set('redirect_uri', redirectUri);
    notionAuthUrl.searchParams.set('state', state);
    notionAuthUrl.searchParams.set('scope', 'databases.read,databases.write');

    res.json({ url: notionAuthUrl.toString(), state });
  } catch (error) {
    console.error('[Notion] 產生授權 URL 失敗:', error);
    res.status(500).json({ error: '無法產生 Notion 授權網址' });
  }
});

// 舊版回呼路徑相容性：將 /api/notion/callback 重新導向至新的 oauth/callback
app.get('/api/notion/callback', (req, res) => {
  const params = new URLSearchParams();
  Object.entries(req.query || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined) {
          params.append(key, String(item));
        }
      });
    } else if (value !== undefined) {
      params.append(key, String(value));
    }
  });

  const queryString = params.toString();
  const redirectPath = `/api/notion/oauth/callback${queryString ? `?${queryString}` : ''}`;
  res.redirect(302, redirectPath);
});

/**
 * Notion OAuth callback
 * GET /api/notion/oauth/callback
 */
app.get('/api/notion/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  const sendOAuthResult = (payload, targetOrigin) => {
    const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
    // 只允許已知的前端 origin，避免 postMessage 被任意第三方截取
    const knownOrigins = ALLOWED_ORIGINS.concat(
      process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []
    );
    const safeOrigin = knownOrigins.includes(targetOrigin)
      ? targetOrigin
      : (process.env.FRONTEND_URL || 'http://localhost:3000');
    const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Notion 授權</title>
  </head>
  <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh;">
    <div>
      <p>正在關閉視窗...</p>
    </div>
    <script>
      (function () {
        const payload = ${safePayload};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'notion:oauth:result', payload }, '${safeOrigin}');
          window.close();
        } else {
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(payload, null, 2);
          document.body.innerHTML = '';
          document.body.appendChild(pre);
        }
      })();
    </script>
  </body>
</html>`;
    res.type('text/html').send(html);
  };

  pruneExpiredNotionStates();

  if (error) {
    console.error('[Notion] OAuth error:', error, errorDescription);
    return sendOAuthResult(
      {
        success: false,
        error,
        message: errorDescription || 'Notion 授權失敗',
      },
      process.env.FRONTEND_URL
    );
  }

  if (!state || !notionStateStore.has(state)) {
    console.error('[Notion] OAuth state 驗證失敗');
    return sendOAuthResult(
      {
        success: false,
        error: 'invalid_state',
        message: '授權逾時或來源無效，請重新嘗試。',
      },
      process.env.FRONTEND_URL
    );
  }

  const stateMeta = notionStateStore.get(state);
  notionStateStore.delete(state);

  if (!code) {
    return sendOAuthResult(
      {
        success: false,
        error: 'missing_code',
        message: '未收到授權碼，請重新嘗試。',
      },
      stateMeta?.origin || process.env.FRONTEND_URL
    );
  }

  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  const redirectUri = process.env.NOTION_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('[Notion] OAuth 環境變數未設定完整');
    return sendOAuthResult(
      {
        success: false,
        error: 'missing_environment',
        message: '伺服器未設定 Notion OAuth 所需環境變數。',
      },
      stateMeta?.origin || process.env.FRONTEND_URL
    );
  }

  try {
    const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('[Notion] 交換 token 失敗:', tokenData);
      return sendOAuthResult(
        {
          success: false,
          error: 'token_exchange_failed',
          message: tokenData?.message || 'Notion token 交換失敗，請稍後再試。',
        },
        stateMeta?.origin || process.env.FRONTEND_URL
      );
    }

    sendOAuthResult(
      {
        success: true,
        data: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          workspaceId: tokenData.workspace_id || null,
          workspaceName: tokenData.workspace_name || '',
          workspaceIcon: tokenData.workspace_icon || null,
          botId: tokenData.bot_id || null,
          duplicatedTemplateId: tokenData.duplicated_template_id || null,
        },
      },
      stateMeta?.origin || process.env.FRONTEND_URL
    );
  } catch (err) {
    console.error('[Notion] OAuth callback 發生錯誤:', err);
    sendOAuthResult(
      {
        success: false,
        error: 'unexpected_error',
        message: err.message || 'Notion 授權時發生未知錯誤。',
      },
      stateMeta?.origin || process.env.FRONTEND_URL
    );
  }
});

/**
 * 發佈文章到 Notion 資料庫
 * POST /api/notion/publish
 */
app.post('/api/notion/publish', async (req, res) => {
  try {
    const {
      notionToken,
      databaseId,
      title,
      article,
      seoDescription,
      videoUrl,
      titleProperty,
      screenshotPlan,
      imageUrls,
    } = req.body || {};

    const resolvedToken = notionToken || process.env.NOTION_API_TOKEN;
    const resolvedDatabaseId = databaseId || process.env.NOTION_DATABASE_ID;
    const resolvedTitleProperty =
      titleProperty || process.env.NOTION_TITLE_PROPERTY || 'Name';

    if (!resolvedToken) {
      return res.status(400).json({
        error: '缺少 Notion 金鑰。請在請求中提供 notionToken 或設定 NOTION_API_TOKEN 環境變數。',
      });
    }

    if (!resolvedDatabaseId) {
      return res.status(400).json({
        error: '缺少 Notion 資料庫 ID。請在請求中提供 databaseId 或設定 NOTION_DATABASE_ID 環境變數。',
      });
    }

    if (typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: '缺少 Notion 頁面標題。' });
    }

    if (typeof article !== 'string' || article.trim().length === 0) {
      return res.status(400).json({ error: '缺少文章內容。' });
    }

    console.log('[Notion] 正在發佈文章到資料庫:', resolvedDatabaseId);

    const result = await publishArticleToNotion({
      notionToken: resolvedToken,
      databaseId: resolvedDatabaseId,
      title: title.trim(),
      article,
      seoDescription: typeof seoDescription === 'string' ? seoDescription : undefined,
      videoUrl: typeof videoUrl === 'string' ? videoUrl : undefined,
      titleProperty: resolvedTitleProperty,
      screenshotPlan: Array.isArray(screenshotPlan) ? screenshotPlan : undefined,
      imageUrls: Array.isArray(imageUrls) ? imageUrls : undefined,
    });

    console.log('[Notion] 發佈成功，頁面 ID:', result.pageId);

    res.json({
      success: true,
      pageId: result.pageId,
      url: result.url,
    });
  } catch (error) {
    console.error('[Notion] 發佈失敗:', error);
    res.status(500).json({
      error: error.message || 'Notion 發佈失敗，請稍後再試。',
    });
  }
});

/**
 * Notion OAuth 回調處理 (POST - 舊版相容)
 * POST /api/notion/oauth/callback
 */
app.post('/api/notion/oauth/callback', async (req, res) => {
  const { code, state } = req.body;

  if (!code) {
    return res.status(400).json({
      error: 'Missing authorization code'
    });
  }

  // 驗證 state 防止 CSRF（與 GET callback 相同邏輯）
  if (!state || !notionStateStore.has(state)) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }
  notionStateStore.delete(state);

  const notionClientId = process.env.NOTION_CLIENT_ID;
  const notionClientSecret = process.env.NOTION_CLIENT_SECRET;
  const notionRedirectUri = process.env.NOTION_REDIRECT_URI || 'http://localhost:3000/notion-callback';

  if (!notionClientId || !notionClientSecret) {
    return res.status(500).json({
      error: 'Notion integration not configured properly'
    });
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${notionClientId}:${notionClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: notionRedirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('[Notion OAuth] Token exchange failed:', errorText);
      throw new Error('Failed to exchange authorization code for token');
    }

    const tokenData = await tokenResponse.json();

    res.json({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      workspaceId: tokenData.workspace_id || null,
      workspaceName: tokenData.workspace_name || null,
      workspaceIcon: tokenData.workspace_icon || null,
      botId: tokenData.bot_id || null,
      duplicatedTemplateId: tokenData.duplicated_template_id || null,
    });

  } catch (error) {
    console.error('[Notion OAuth] Callback error:', error);
    res.status(500).json({
      error: 'OAuth callback failed',
      details: error.message
    });
  }
});

/**
 * 取得 Notion 資料庫列表
 * POST /api/notion/databases
 */
app.post('/api/notion/databases', async (req, res) => {
  try {
    const { notionToken, pageSize, startCursor } = req.body || {};

    if (!notionToken) {
      return res.status(400).json({
        error: '缺少 Notion Access Token',
      });
    }

    const parsedPageSize = pageSize ? parseInt(pageSize, 10) : undefined;

    const result = await listNotionDatabases(notionToken, {
      pageSize: parsedPageSize,
      startCursor: startCursor || undefined,
    });

    res.json(result);
  } catch (error) {
    console.error('[Notion] 取得資料庫列表失敗:', error);
    const statusCode = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(statusCode).json({
      error: error.message || '取得 Notion 資料庫列表失敗',
    });
  }
});

/**
 * 取得指定 Notion 資料庫的欄位資訊
 * POST /api/notion/database-info
 */
app.post('/api/notion/database-info', async (req, res) => {
  try {
    const { notionToken, databaseId } = req.body || {};

    if (!notionToken || !databaseId) {
      return res.status(400).json({
        error: '缺少 Notion Access Token 或資料庫 ID',
      });
    }

    const databaseInfo = await getNotionDatabase(notionToken, databaseId);

    res.json(databaseInfo);
  } catch (error) {
    console.error('[Notion] 取得資料庫資訊失敗:', error);
    const statusCode = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    res.status(statusCode).json({
      error: error.message || '取得 Notion 資料庫資訊失敗',
    });
  }
});

// ==================== JSON 修復工具 ====================

/**
 * 修復 Gemini 回應中 JSON 字串裡的控制字元。
 * Gemini 有時在 HTML 內容裡直接嵌入換行符（0x00-0x1F），不合 JSON spec。
 * 此函數以字元為單位掃描，只在字串內部替換控制字元，不影響 JSON 結構符號。
 */
function repairJsonControlChars(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const code = text.charCodeAt(i);

    if (escaped) {
      result += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      result += c;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      result += c;
      continue;
    }
    if (inString && code < 0x20) {
      if (c === '\n') result += '\\n';
      else if (c === '\r') result += '\\r';
      else if (c === '\t') result += '\\t';
      else result += '\\u' + ('0000' + code.toString(16)).slice(-4);
      continue;
    }
    result += c;
  }
  return result;
}

function parseGeminiJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // jsonrepair handles unescaped quotes, control chars, trailing commas, etc.
    return JSON.parse(jsonrepair(text));
  }
}

// ==================== 安全性驗證函數 ====================

/**
 * 驗證 YouTube Video ID 格式
 * YouTube Video ID 格式：11 個字元，僅允許 a-z, A-Z, 0-9, -, _
 * @param {string} videoId - 要驗證的 Video ID
 * @returns {boolean} - 是否為有效格式
 */
function isValidVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') {
    return false;
  }
  // YouTube Video ID 固定為 11 個字元
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId);
}

// ==================== 截圖工具函數 ====================

/**
 * 將時間字串（mm:ss）轉換為秒數
 * @param {string} timeStr - 時間字串（格式：mm:ss）
 * @returns {number} - 秒數
 */
function timeToSeconds(timeStr) {
  const [minutes, seconds] = timeStr.split(':').map(Number);
  return minutes * 60 + seconds;
}

/**
 * 將秒數轉換為時間字串（mm:ss）
 * @param {number} seconds - 秒數
 * @returns {string} - 時間字串（格式：mm:ss）
 */
function secondsToTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * 使用 FFmpeg 截取影片畫面
 * @param {string} videoPath - 影片檔案路徑
 * @param {number} timeInSeconds - 截圖時間點（秒）
 * @param {string} outputPath - 輸出檔案路徑
 * @param {number} quality - 截圖品質（2-31，數字越小品質越高），預設 2（最高品質）
 * @returns {Promise<void>}
 */
async function captureScreenshot(videoPath, timeInSeconds, outputPath, quality = 2) {
  // 限制品質範圍在 2-31 之間
  const validQuality = Math.max(2, Math.min(31, quality));

  // FFmpeg 截圖命令
  // -ss: 指定時間點
  // -i: 輸入檔案
  // -vframes 1: 只截取一幀
  // -q:v: JPEG 品質（2=最高品質，31=最低品質）
  // -y: 覆蓋已存在的檔案
  const command = `ffmpeg -ss ${timeInSeconds} -i "${videoPath}" -vframes 1 -q:v ${validQuality} "${outputPath}" -y`;
  await execAsync(command);
}

// =============== Files API helpers ===============
/**
 * 使用 Files API 以 displayName 尋找檔案（支援分頁）。
 * 回傳第一個符合 displayName 的檔案（可為任何 state）。
 */
async function findFileByDisplayName(ai, displayName) {
  try {
    const iterable = await ai.files.list({ config: { pageSize: 50 } });
    for await (const file of iterable) {
      if (file?.displayName === displayName) {
        return file;
      }
    }
    return null;
  } catch (err) {
    console.error('[FilesAPI] list error:', err?.message || err);
    throw err;
  }
}

// ==================== API 端點 ====================

/**
 * 下載 YouTube 影片
 * POST /api/download-video
 * Body: { videoId: string, accessToken: string, quality?: number }
 */
app.post('/api/download-video', async (req, res) => {
  const { videoId, accessToken, quality = 2 } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

  try {
    console.log(`\n========== 🎬 開始下載影片 ==========`);
    console.log(`[Download] Video ID: ${videoId}`);
    console.log(`[Download] Video URL: ${videoUrl}`);

    // 檢查 yt-dlp 是否安裝
    console.log(`[Download] Checking yt-dlp installation...`);
    try {
      const { stdout } = await execAsync('yt-dlp --version');
      console.log(`[Download] ✅ yt-dlp version: ${stdout.trim()}`);
    } catch (error) {
      console.error(`[Download] ❌ yt-dlp not found`);
      return res.status(500).json({
        error: 'yt-dlp is not installed. Please install it: https://github.com/yt-dlp/yt-dlp#installation'
      });
    }

    // 使用 yt-dlp 下載未列出影片
    // 不使用 cookies，依賴 yt-dlp 的內建機制

    // 根據截圖品質決定影片解析度
    // quality=2（高畫質截圖）→ 下載 1080p 影片（至少 720p）
    // quality=20（壓縮截圖）→ 下載 720p 影片（至少 480p）
    let formatSelector;
    if (quality <= 10) {
      // 高品質：優先 1080p，次選 720p，最後接受 >=480p 或最佳
      formatSelector = '"bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best"';
      console.log(`[Download] 截圖品質: ${quality}（高畫質）→ 目標影片解析度: 1080p (退回 720p)`);
    } else {
      // 壓縮：優先 720p，次選 480p，最後接受 360p 或最佳
      formatSelector = '"bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best"';
      console.log(`[Download] 截圖品質: ${quality}（壓縮）→ 目標影片解析度: 720p (退回 480p)`);
    }

    // 建構命令（使用陣列避免換行問題）
    // 注意：不使用 android client，因為它限制只能下載 360p
    // 對於未列出的影片，現代 yt-dlp 可以不需要 cookies 直接下載
    const commandParts = [
      'yt-dlp',
      // 根據品質選擇格式
      '-f', formatSelector,
      // 如果下載分離的音視頻流，合併為 mp4
      '--merge-output-format', 'mp4',
      '-o', `"${outputPath}"`,
      // 增加重試次數
      '--retries', '5',
      '--fragment-retries', '5',
      // 添加影片 URL
      `"${videoUrl}"`,
    ];

    const command = commandParts.join(' ');

    console.log(`[Download] Executing command:\n${command}`);
    console.log(`[Download] 正在下載影片,請稍候...`);

    const { stdout, stderr } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });

    if (stdout) console.log('[Download] yt-dlp output:', stdout);
    if (stderr) console.log('[Download] yt-dlp warnings:', stderr);

    if (!fs.existsSync(outputPath)) {
      throw new Error('Video download failed - file not found');
    }

    const stats = fs.statSync(outputPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`[Download] ✅ 影片下載成功!`);
    console.log(`[Download] 檔案路徑: ${outputPath}`);
    console.log(`[Download] 檔案大小: ${fileSizeMB} MB`);
    console.log(`========== 下載完成 ==========\n`);

    res.json({
      success: true,
      filePath: outputPath,
      videoId
    });

  } catch (error) {
    console.error('Download error:', error);

    // 提供更詳細的錯誤訊息
    let errorDetails = error.message;
    if (error.stderr) {
      errorDetails += `\nstderr: ${error.stderr}`;
    }
    if (error.stdout) {
      errorDetails += `\nstdout: ${error.stdout}`;
    }

    res.status(500).json({
      error: 'Failed to download video',
      details: errorDetails,
      videoId,
      videoUrl
    });
  }
});

/**
 * 使用 YouTube URL 直接分析影片（僅限公開影片）
 * POST /api/analyze-video-url
 * Body: { videoId: string, prompt: string, videoTitle: string }
 */
app.post('/api/analyze-video-url', async (req, res) => {
  const { videoId, prompt, videoTitle } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    console.log(`\n========== 🤖 使用 YouTube URL 分析影片 ==========`);
    console.log(`[Analyze URL] Video ID: ${videoId}`);
    console.log(`[Analyze URL] YouTube URL: ${youtubeUrl}`);
    console.log(`[Analyze URL] Video Title: ${videoTitle}`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 生成提示詞
    console.log('[Analyze URL] 正在生成 SEO 強化內容...');
    const fullPrompt = generateFullPrompt(videoTitle, prompt);

    // 直接使用 YouTube URL 呼叫 Gemini API
    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: youtubeUrl } },
            { text: fullPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,  // 設定較高的 token 上限，避免生成結果被截斷
      },
    });

    console.log('[Analyze URL] ✅ Gemini 分析完成!');
    const result = parseGeminiJson(response.text);
    console.log(`[Analyze URL] Generated: ${result.titleA}`);
    console.log(`========== 分析完成 ==========\n`);

    res.json({
      success: true,
      metadata: result,
      usedYouTubeUrl: true
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({
      error: 'Failed to analyze video via YouTube URL',
      details: error.message
    });
  }
});

/**
 * 使用 YouTube URL 直接分析影片（異步版本，適合手機端）
 * POST /api/analyze-video-url-async
 * Body: { videoId: string, prompt: string, videoTitle: string }
 */
app.post('/api/analyze-video-url-async', async (req, res) => {
  const { videoId, prompt, videoTitle } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  try {
    console.log(`\n========== 🤖 [異步] 使用 YouTube URL 分析影片 ==========`);
    console.log(`[Analyze URL Async] Video ID: ${videoId}`);
    console.log(`[Analyze URL Async] Video Title: ${videoTitle}`);

    // 創建異步任務
    const taskId = taskQueue.createTask('analyze-video-url', {
      videoId,
      prompt,
      videoTitle
    });

    console.log(`[Analyze URL Async] Task created: ${taskId}`);
    res.json({ taskId });

    // 在背景執行任務
    taskQueue.executeTask(taskId, async (taskId) => {
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

      taskQueue.updateTaskProgress(taskId, 10, '正在初始化 Gemini AI...');
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: GEMINI_HTTP_OPTIONS
      });

      taskQueue.updateTaskProgress(taskId, 30, '正在生成 SEO 強化內容...');
      const fullPrompt = generateFullPrompt(videoTitle, prompt);

      taskQueue.updateTaskProgress(taskId, 50, '正在使用 YouTube URL 分析影片...');
      const response = await generateContentWithFallback(ai, {
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { fileUri: youtubeUrl } },
              { text: fullPrompt }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
        },
      });

      taskQueue.updateTaskProgress(taskId, 90, '正在解析 Gemini 回應...');
      const result = parseGeminiJson(response.text);

      console.log(`[Analyze URL Async] ✅ 分析完成: ${result.titleA}`);

      return {
        success: true,
        metadata: result,
        usedYouTubeUrl: true
      };
    });

  } catch (error) {
    console.error('[Analyze URL Async] Error:', error);
    res.status(500).json({
      error: 'Failed to create async analysis task',
      details: error.message
    });
  }
});

// （Moved to bottom）

/**
 * 上傳影片到 Gemini 並生成 metadata（用於非公開影片）
 * POST /api/analyze-video
 * Body: { videoId: string, filePath?: string, prompt: string, videoTitle: string }
 */
app.post('/api/analyze-video', async (req, res) => {
  const { videoId, filePath: rawFilePath, prompt, videoTitle } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  let filePath;
  try {
    filePath = validateFilePath(rawFilePath);
  } catch {
    return res.status(400).json({ error: 'Invalid filePath' });
  }

  try {
    console.log(`\n========== 🤖 開始分析影片 ==========`);
    console.log(`[Analyze] Video ID: ${videoId}`);
    console.log(`[Analyze] File Path: ${filePath || '(not provided, will check Files API)'}`);
    console.log(`[Analyze] Video Title: ${videoTitle}`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 先檢查檔案是否已存在於 Files API
    console.log('[Analyze] 步驟 1/4: 檢查 Files API 中是否已有此檔案...');
    const existingFile = await findFileByDisplayName(ai, videoId);

    let uploadedFile;
    let reusedFile = false;

    if (existingFile) {
      console.log(`[Analyze] ✅ 找到已存在的檔案，將重複使用！`);
      console.log(`[Analyze] File Name: ${existingFile.name}`);
      console.log(`[Analyze] Display Name: ${existingFile.displayName}`);
      console.log(`[Analyze] File URI: ${existingFile.uri}`);
      console.log(`[Analyze] 跳過上傳步驟，節省時間和流量！`);
      uploadedFile = existingFile;
      reusedFile = true;

      // 刪除本地已下載的暫存檔案（如果有提供的話）
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Analyze] 🗑️  已刪除不需要的暫存檔案: ${filePath}`);
      }
    } else {
      // 檔案不存在於 Files API
      if (!filePath) {
        return res.status(400).json({
          error: 'File not found in Files API and no filePath provided for upload'
        });
      }

      console.log('[Analyze] 檔案不存在，需要上傳...');
      // 上傳影片到 Gemini（使用 videoId 作為 displayName）
      uploadedFile = await ai.files.upload({
        file: filePath,
        config: {
          mimeType: 'video/mp4',
          displayName: videoId  // 使用 videoId 作為檔案名稱，方便後續查找
        },
      });

      console.log(`[Analyze] ✅ 檔案已上傳`);
      console.log(`[Analyze] File Name (系統生成): ${uploadedFile.name}`);
      console.log(`[Analyze] Display Name (我們設定): ${uploadedFile.displayName}`);
      console.log(`[Analyze] File URI: ${uploadedFile.uri}`);
      console.log(`[Analyze] File State: ${uploadedFile.state}`);
    }

    // 等待檔案處理完成（變成 ACTIVE 狀態）
    if (uploadedFile.state === 'PROCESSING') {
        console.log('[Analyze] ⏳ Gemini 正在處理影片,等待處理完成...');

        let attempts = 0;
        const maxAttempts = 60; // 最多等待 60 次（約 5 分鐘）
        let isActive = false;

        while (!isActive && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000)); // 等待 5 秒

          try {
            // 使用 files.get() 來檢查特定檔案的狀態
            const fetchedFile = await ai.files.get({ name: uploadedFile.name });

            if (fetchedFile) {
              const progress = Math.round(((attempts + 1) / maxAttempts) * 100);
              console.log(`[Analyze] 檢查狀態 ${attempts + 1}/${maxAttempts} (${progress}%) - State: ${fetchedFile.state}`);

              if (fetchedFile.state === 'ACTIVE') {
                isActive = true;
                console.log('[Analyze] ✅ 檔案處理完成,可以開始分析!');
              } else if (fetchedFile.state === 'FAILED') {
                throw new Error('File processing failed');
              }
            }
          } catch (error) {
            console.log(`[Analyze] ⚠️  檢查 ${attempts + 1}/${maxAttempts} 時發生錯誤: ${error.message}`);
            // 繼續嘗試
          }

          attempts++;
        }

        if (!isActive) {
          throw new Error('File processing timeout. Please try again later.');
        }
      } else if (uploadedFile.state === 'ACTIVE') {
        console.log('[Analyze] ✅ 檔案已經是 ACTIVE 狀態');
      } else {
        throw new Error(`Unexpected file state: ${uploadedFile.state}`);
      }

    // 生成提示詞
    console.log('[Analyze] 步驟 4/4: 正在生成 SEO 強化內容...');
    const fullPrompt = generateFullPrompt(videoTitle, prompt);

    // 呼叫 Gemini API
    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: uploadedFile.uri, mimeType: 'video/mp4' } },
            { text: fullPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,  // 設定較高的 token 上限，避免生成結果被截斷
      },
    });

    console.log('[Analyze] ✅ Gemini 分析完成!');
    const result = parseGeminiJson(response.text);
    console.log(`[Analyze] Generated: ${result.titleA}`);

    // 清理暫存檔案（如果還存在的話）
    if (!reusedFile && filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Analyze] 🗑️  已刪除暫存檔案: ${filePath}`);
    }
    console.log(`========== 分析完成 ==========\n`);

    res.json({
      success: true,
      metadata: result,
      geminiFileName: uploadedFile.name,
      geminiFileUri: uploadedFile.uri
    });

  } catch (error) {
    console.error('Analysis error:', error);

    // 清理暫存檔案
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.status(500).json({
      error: 'Failed to analyze video',
      details: error.message
    });
  }
});

/**
 * 檢查 Gemini 檔案是否仍然存在並重新分析
 * POST /api/reanalyze-with-existing-file
 * Body: { geminiFileName: string, prompt: string, videoTitle: string }
 */
app.post('/api/reanalyze-with-existing-file', async (req, res) => {
  const { geminiFileName, prompt, videoTitle } = req.body;

  if (!geminiFileName) {
    return res.status(400).json({ error: 'Missing geminiFileName' });
  }

  try {
    console.log(`Checking if Gemini file exists: ${geminiFileName}`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 嘗試取得檔案
    let fileInfo;
    try {
      fileInfo = await ai.files.get({ name: geminiFileName });
    } catch (error) {
      console.log(`File not found or error: ${error.message}`);
      return res.status(404).json({ error: 'File not found', needsRedownload: true });
    }

    // 檢查檔案狀態
    if (fileInfo.state === 'FAILED') {
      return res.status(404).json({ error: 'File processing failed', needsRedownload: true });
    }

    if (fileInfo.state !== 'ACTIVE') {
      return res.status(400).json({ error: 'File is not ready', state: fileInfo.state });
    }

    console.log(`✅ File found and active: ${fileInfo.uri}`);

    // 生成提示詞（與 analyze-video 相同）
    const fullPrompt = generateFullPrompt(videoTitle, prompt);

    // 呼叫 Gemini API
    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: fileInfo.uri, mimeType: 'video/mp4' } },
            { text: fullPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,  // 設定較高的 token 上限，避免生成結果被截斷
      },
    });

    const result = parseGeminiJson(response.text);

    res.json({
      success: true,
      metadata: result,
      geminiFileName: fileInfo.name,
      geminiFileUri: fileInfo.uri,
      reusedExistingFile: true
    });

  } catch (error) {
    console.error('Reanalysis error:', error);
    res.status(500).json({
      error: 'Failed to reanalyze video',
      details: error.message
    });
  }
});

/**
 * 上傳參考檔案到 Gemini Files API
 * POST /api/gemini/upload-file
 * Content-Type: multipart/form-data
 * Body: FormData with 'file' field
 */
app.post('/api/gemini/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`[Gemini Upload] 收到檔案上傳請求: ${req.file.originalname}`);
    console.log(`[Gemini Upload] 檔案大小: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[Gemini Upload] MIME Type: ${req.file.mimetype}`);

    // 讀取暫存檔案
    const filePath = req.file.path;

    // 上傳到 Gemini Files API
    const uploadedFile = await ai.files.upload({
      file: filePath,
      config: {
        mimeType: req.file.mimetype,
        displayName: req.file.originalname
      }
    });

    console.log(`[Gemini Upload] ✅ 檔案上傳成功`);
    console.log(`[Gemini Upload] File Name: ${uploadedFile.name}`);
    console.log(`[Gemini Upload] File URI: ${uploadedFile.uri}`);
    console.log(`[Gemini Upload] File State: ${uploadedFile.state}`);

    // 等待檔案處理完成
    if (uploadedFile.state === 'PROCESSING') {
      console.log('[Gemini Upload] ⏳ 等待 Gemini 處理檔案...');
      let attempts = 0;
      const maxAttempts = 30;
      let isActive = false;

      while (!isActive && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          const fetchedFile = await ai.files.get({ name: uploadedFile.name });
          if (fetchedFile.state === 'ACTIVE') {
            isActive = true;
            console.log('[Gemini Upload] ✅ 檔案處理完成');
          } else if (fetchedFile.state === 'FAILED') {
            throw new Error('File processing failed');
          }
        } catch (error) {
          console.log(`[Gemini Upload] ⚠️  檢查狀態時發生錯誤: ${error.message}`);
        }
        attempts++;
      }

      if (!isActive) {
        throw new Error('File processing timeout');
      }
    }

    // 刪除暫存檔案
    try {
      fs.unlinkSync(filePath);
      console.log(`[Gemini Upload] 🗑️  已刪除暫存檔案: ${filePath}`);
    } catch (err) {
      console.warn(`[Gemini Upload] ⚠️  無法刪除暫存檔案: ${err.message}`);
    }

    // 返回檔案資訊（符合前端 UploadedFile 介面）
    res.json({
      name: uploadedFile.name,
      uri: uploadedFile.uri,
      mimeType: uploadedFile.mimeType,
      displayName: uploadedFile.displayName,
      sizeBytes: uploadedFile.sizeBytes
    });

  } catch (error) {
    console.error('[Gemini Upload] Error:', error);

    // 清理暫存檔案
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {
        // 忽略清理錯誤
      }
    }

    res.status(500).json({
      error: 'Failed to upload file to Gemini',
      details: error.message
    });
  }
});

/**
 * 從 Gemini Files API 刪除檔案
 * DELETE /api/gemini/file/:name
 */
app.delete('/api/gemini/file/:name', async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.name);
    console.log(`[Gemini Delete] 刪除檔案: ${fileName}`);

    await ai.files.delete({ name: fileName });

    console.log(`[Gemini Delete] ✅ 檔案已刪除`);
    res.json({ success: true });

  } catch (error) {
    console.error('[Gemini Delete] Error:', error);
    res.status(500).json({
      error: 'Failed to delete file from Gemini',
      details: error.message
    });
  }
});

/**
 * 使用 YouTube URL 生成文章（僅限公開影片）
 * POST /api/generate-article-url
 * Body: { videoId: string, prompt: string, videoTitle: string, quality?: number }
 */
app.post('/api/generate-article-url', async (req, res) => {
  const { videoId, prompt, videoTitle, quality = 2 } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

  try {
    console.log(`\n========== 📝 使用 YouTube URL 生成文章 ==========`);
    console.log(`[Article URL] Video ID: ${videoId}`);
    console.log(`[Article URL] YouTube URL: ${youtubeUrl}`);
    console.log(`[Article URL] Video Title: ${videoTitle}`);

    // 檢查 FFmpeg 是否安裝
    console.log('[Article URL] Checking FFmpeg installation...');
    try {
      const { stdout } = await execAsync('ffmpeg -version');
      const version = stdout.split('\n')[0];
      console.log(`[Article URL] ✅ FFmpeg found: ${version}`);
    } catch (error) {
      console.error('[Article URL] ❌ FFmpeg not found');
      return res.status(500).json({
        error: 'FFmpeg is not installed. Please install it first.',
        details: 'Install FFmpeg: brew install ffmpeg (macOS) or sudo apt install ffmpeg (Ubuntu)'
      });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 步驟 1: 使用 YouTube URL 生成文章與截圖時間點
    console.log('[Article URL] 步驟 1/3: 使用 YouTube URL 分析影片並生成文章...');
    const fullPrompt = generateArticlePrompt(videoTitle, prompt);

    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: youtubeUrl } },
            { text: fullPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    let result;
    try {
      const responseText = response.text;
      console.log(`[Article URL] ✅ Gemini 回應長度: ${responseText.length} 字元`);
      result = parseGeminiJson(responseText);

      if (!result.titleA || !result.titleB || !result.titleC || !result.article_text || !result.screenshots) {
        throw new Error('Missing required fields in response');
      }

      console.log(`[Article URL] ✅ 文章生成成功! 找到 ${result.screenshots.length} 個截圖時間點`);
      console.log(`[Article URL] 標題 A: ${result.titleA}`);
      console.log(`[Article URL] 截圖規劃已生成，等待使用者手動觸發截圖`);
    } catch (parseError) {
      console.error('[Article URL] ❌ JSON parsing error:', parseError.message);
      throw new Error(`無法解析 Gemini 回應為 JSON 格式。錯誤：${parseError.message}`);
    }

    console.log(`========== 文章生成完成 ==========\n`);

    res.json({
      success: true,
      titleA: result.titleA,
      titleB: result.titleB,
      titleC: result.titleC,
      article: postprocessArticleHtml(result.article_text),
      seo_description: result.seo_description,
      image_urls: [],  // 空陣列，等待使用者手動截圖
      screenshots: result.screenshots,  // 返回截圖規劃
      videoId,  // 返回 videoId 供後續截圖使用
      usedYouTubeUrl: true,
      needsScreenshots: true,  // 標記截圖已規劃但未執行
      screenshotsCount: result.screenshots.length
    });

  } catch (error) {
    console.error('Article generation error:', error);

    res.status(500).json({
      error: 'Failed to generate article via YouTube URL',
      details: error.message
    });
  }
});

/**
 * 使用 YouTube URL 生成文章（異步版本，適合手機端）
 * POST /api/generate-article-url-async
 * Body: { videoId: string, prompt: string, videoTitle: string, quality?: number }
 */
app.post('/api/generate-article-url-async', async (req, res) => {
  const {
    videoId,
    prompt,
    videoTitle,
    quality = 2,
    uploadedFiles = [],
    accessToken,
    templateId = 'default',
    colorTheme = 'neutral',
    referenceUrls = [],
    referenceVideos = []
  } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  try {
    // 創建任務
    const taskId = taskQueue.createTask('generate-article-url', {
      videoId,
      prompt,
      videoTitle,
      quality,
      uploadedFiles,
      accessToken,
      templateId,
      referenceUrls,
      referenceVideos
    });

    // 立即返回任務 ID
    res.json({
      success: true,
      taskId,
      message: '任務已建立，請使用 taskId 查詢進度'
    });

    // 在背景執行任務
    taskQueue.executeTask(taskId, async (taskId) => {
      // 速率限制檢查
      const rateLimitId = accessToken || req.ip;
      const clientIp = req.ip;

      const tokenRateCheck = checkRateLimit(rateLimitId, downloadRateLimiter, MAX_DOWNLOADS_PER_HOUR);
      if (!tokenRateCheck.allowed) {
        throw new Error(`下載次數已達上限，請在 ${tokenRateCheck.waitMinutes} 分鐘後再試`);
      }

      const ipRateCheck = checkRateLimit(clientIp, ipRateLimiter, MAX_DOWNLOADS_PER_HOUR_PER_IP);
      if (!ipRateCheck.allowed) {
        throw new Error(`此 IP 位址下載次數過多，請在 ${ipRateCheck.waitMinutes} 分鐘後再試`);
      }

      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

      console.log(`\n========== 📝 [Task ${taskId}] 使用 YouTube URL 生成文章 ==========`);
      console.log(`[Article URL] Video ID: ${videoId}`);
      console.log(`[Article URL] YouTube URL: ${youtubeUrl}`);
      console.log(`[Article URL] Video Title: ${videoTitle}`);
      console.log(`[Article URL] Template: ${templateId}`);

      if (uploadedFiles.length > 0) {
        console.log(`[Article URL] 📎 上傳的參考檔案: ${uploadedFiles.length} 個`);
      }

      taskQueue.updateTaskProgress(taskId, 10, '檢查 FFmpeg 安裝狀態...');

      // 檢查 FFmpeg 是否安裝
      try {
        const { stdout } = await execAsync('ffmpeg -version');
        const version = stdout.split('\n')[0];
        console.log(`[Article URL] ✅ FFmpeg found: ${version}`);
      } catch (error) {
        throw new Error('FFmpeg is not installed. Please install it first.');
      }

      taskQueue.updateTaskProgress(taskId, 20, '初始化 Gemini AI...');

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: GEMINI_HTTP_OPTIONS
      });

      // 步驟 1: 使用 YouTube URL 生成文章與截圖時間點
      taskQueue.updateTaskProgress(taskId, 30, '使用 YouTube URL 分析影片並生成文章...');
      console.log('[Article URL] 步驟 1/3: 使用 YouTube URL 分析影片並生成文章...');

      // 使用新的 prompt 生成函數，整合所有參考資料
      const { generateArticlePromptWithReferences } = await import('./services/articlePromptService.js');

      // 準備參考資料物件
      const references = {
        uploadedFiles: uploadedFiles || [],
        referenceVideos: referenceVideos || [],
        referenceUrls: referenceUrls || []
      };

      // 生成包含所有參考資料指示的完整 prompt
      const fullPrompt = await generateArticlePromptWithReferences(videoTitle, prompt, references, templateId, 'video', colorTheme);

      // 建立 parts 陣列
      const parts = [
        { fileData: { fileUri: youtubeUrl } }
      ];

      // 加入使用者上傳的參考檔案
      if (uploadedFiles.length > 0) {
        console.log(`[Article URL] 📎 上傳的參考檔案: ${uploadedFiles.length} 個`);
        for (const file of uploadedFiles) {
          console.log(`[Article URL] 加入參考檔案: ${file.displayName} (${file.mimeType})`);
          parts.push({
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.uri
            }
          });
        }
      }

      // 加入參考影片
      if (referenceVideos && referenceVideos.length > 0) {
        console.log(`[Article URL] 📎 參考影片: ${referenceVideos.length} 個`);
        for (const videoUrl of referenceVideos) {
          console.log(`[Article URL] 加入參考影片: ${videoUrl}`);
          parts.push({ fileData: { fileUri: videoUrl } });
        }
      }

      // 記錄參考網址數量
      if (referenceUrls && referenceUrls.length > 0) {
        console.log(`[Article URL] 📎 參考網址: ${referenceUrls.length} 個`);
      }

      // 加入完整的 prompt（已包含所有參考資料的整合指示）
      const finalPrompt = `${fullPrompt}\n\n**重要：請確保你的回應是有效的 JSON 格式，不要包含任何額外的說明文字。**`;
      parts.push({ text: finalPrompt });

      // 日誌：顯示最終的 parts 結構
      console.log(`[Article URL] 📊 Parts 結構總覽:`);
      console.log(`[Article URL]   - 總共 ${parts.length} 個 parts`);
      parts.forEach((part, index) => {
        if (part.fileData) {
          console.log(`[Article URL]   - Part ${index + 1}: 檔案/影片 (${part.fileData.fileUri?.substring(0, 50)}...)`);
        } else if (part.text) {
          console.log(`[Article URL]   - Part ${index + 1}: 文字 (長度: ${part.text.length} 字元)`);
        }
      });

      taskQueue.updateTaskProgress(taskId, 50, 'Gemini AI 正在分析影片內容...');

      // 添加重試機制處理 503 錯誤
      let response;
      let attempts = 0;
      const maxAttempts = 3;

      // 準備 config
      const geminiConfig = {};

      // 如果有參考網址，啟用 URL Context 工具
      if (referenceUrls && referenceUrls.length > 0) {
        geminiConfig.tools = [{ urlContext: {} }];
        console.log(`[Article URL] 🔧 已啟用 URL Context 工具（無法使用 responseMimeType）`);
      } else {
        // 只有在沒有使用工具時才能指定 responseMimeType
        geminiConfig.responseMimeType = "application/json";
      }

      while (attempts < maxAttempts) {
        try {
          response = await generateContentWithFallback(ai, {
            contents: [
              {
                role: 'user',
                parts: parts
              }
            ],
            config: geminiConfig,
          });
          break;
        } catch (error) {
          attempts++;
          if (error.status === 503 && attempts < maxAttempts) {
            const waitTime = attempts * 5;
            console.log(`[Article URL] ⚠️  Gemini API 過載，${waitTime} 秒後重試（第 ${attempts}/${maxAttempts} 次）...`);
            taskQueue.updateTaskProgress(taskId, 50 + attempts * 5, `Gemini API 過載，${waitTime} 秒後重試...`);
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
          } else {
            throw error;
          }
        }
      }

      taskQueue.updateTaskProgress(taskId, 80, '解析 Gemini AI 回應...');

      // 檢查 URL Context metadata
      if (response.candidates && response.candidates[0]?.urlContextMetadata) {
        const metadata = response.candidates[0].urlContextMetadata;
        console.log(`[Article URL] 🔍 URL Context Metadata:`);
        if (metadata.urlMetadata && metadata.urlMetadata.length > 0) {
          console.log(`[Article URL]   ✅ 成功抓取 ${metadata.urlMetadata.length} 個網址的內容：`);
          metadata.urlMetadata.forEach((urlMeta, index) => {
            console.log(`[Article URL]   - URL ${index + 1}: ${urlMeta.retrievedUrl}`);
            console.log(`[Article URL]     狀態: ${urlMeta.urlRetrievalStatus}`);
          });
        } else {
          console.log(`[Article URL]   ⚠️  沒有 URL metadata 資料（可能是 Gemini 沒有使用 URL Context 工具）`);
        }
      } else {
        console.log(`[Article URL]   ⚠️  回應中沒有 URL Context Metadata`);
      }

      let result;
      try {
        let responseText = response.text;
        console.log(`[Article URL] ✅ Gemini 回應長度: ${responseText.length} 字元`);

        // 當使用工具時，可能需要提取 JSON
        if (referenceUrls && referenceUrls.length > 0) {
          console.log(`[Article URL] 🔍 使用工具模式，嘗試提取 JSON...`);
          // 嘗試找到 JSON 對象
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            responseText = jsonMatch[0];
            console.log(`[Article URL] ✅ 成功提取 JSON (長度: ${responseText.length} 字元)`);
          } else {
            console.log(`[Article URL] ⚠️ 無法找到 JSON 對象，使用原始回應`);
          }
        }

        result = parseGeminiJson(responseText);

        if (!result.titleA || !result.titleB || !result.titleC || !result.article_text || !result.screenshots) {
          throw new Error('Missing required fields in response');
        }

        console.log(`[Article URL] ✅ 文章生成成功! 找到 ${result.screenshots.length} 個截圖時間點`);
        console.log(`[Article URL] 標題 A: ${result.titleA}`);
      } catch (parseError) {
        console.error('[Article URL] ❌ JSON parsing error:', parseError.message);
        console.error('[Article URL] 回應內容:', response.text.substring(0, 500));
        throw new Error(`無法解析 Gemini 回應為 JSON 格式。錯誤：${parseError.message}`);
      }

      taskQueue.updateTaskProgress(taskId, 100, '文章生成完成！');
      console.log('[Article URL] ✅ 文章生成完成！截圖時間點已規劃');
      console.log(`========== 文章生成完成 ==========\n`);

      return {
        success: true,
        titleA: result.titleA,
        titleB: result.titleB,
        titleC: result.titleC,
        article: postprocessArticleHtml(result.article_text),
        seo_description: result.seo_description,
        image_urls: [],
        screenshots: result.screenshots,
        usedYouTubeUrl: true,
        needsScreenshots: true,
        videoId: videoId
      };
    });

  } catch (error) {
    console.error('Task creation error:', error);
    res.status(500).json({
      error: 'Failed to create task',
      details: error.message
    });
  }
});

/**

/**
 * 手動執行截圖（使用者觸發）
 * POST /api/capture-screenshots
 * Body: { videoId: string, screenshots: array, quality?: number }
 */
app.post('/api/capture-screenshots', async (req, res) => {
  const { videoId, screenshots, quality = 2 } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  if (!screenshots || !Array.isArray(screenshots)) {
    return res.status(400).json({ error: 'Missing or invalid screenshots array' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

  try {
    console.log(`\n========== 📸 開始執行截圖 ==========`);
    console.log(`[Capture Screenshots] Video ID: ${videoId}`);
    console.log(`[Capture Screenshots] 截圖數量: ${screenshots.length}`);
    console.log(`[Capture Screenshots] 截圖品質: ${quality}`);

    // 檢查 FFmpeg 是否安裝
    try {
      await execAsync('ffmpeg -version');
    } catch (error) {
      return res.status(500).json({
        error: 'FFmpeg is not installed',
        details: 'Please install FFmpeg first'
      });
    }

    // 檢查影片是否已經下載，如果沒有則下載
    if (!fs.existsSync(outputPath)) {
      console.log('[Capture Screenshots] 影片尚未下載，開始下載...');

      let formatSelector;
      if (quality <= 10) {
        formatSelector = '"bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best"';
      } else {
        formatSelector = '"bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best"';
      }

      const commandParts = [
        'yt-dlp',
        '-f', formatSelector,
        '--merge-output-format', 'mp4',
        '-o', `"${outputPath}"`,
        '--retries', '5',
        '--fragment-retries', '5',
        `"${youtubeUrl}"`,
      ];

      const command = commandParts.join(' ');
      await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });

      if (!fs.existsSync(outputPath)) {
        throw new Error('Video download failed');
      }

      console.log('[Capture Screenshots] ✅ 影片下載完成');
    } else {
      console.log('[Capture Screenshots] 使用已存在的影片檔案');
    }

    // 執行截圖
    console.log('[Capture Screenshots] 開始截取畫面...');
    const imageUrls = [];

    for (let i = 0; i < screenshots.length; i++) {
      const screenshot = screenshots[i];
      const timestamp = screenshot.timestamp_seconds;
      const currentSeconds = timeToSeconds(timestamp);

      const screenshotGroup = [];
      const offsets = [
        { offset: -2, label: 'before' },
        { offset: 0, label: 'current' },
        { offset: 2, label: 'after' }
      ];

      console.log(`[Capture Screenshots] 截圖組 ${i + 1}/${screenshots.length} - 時間點: ${timestamp}`);

      for (const { offset, label } of offsets) {
        const targetSeconds = Math.max(0, currentSeconds + offset);
        const targetTime = secondsToTime(targetSeconds);
        const outputFilename = `${videoId}_screenshot_${i}_${label}_${targetTime.replace(':', '-')}.jpg`;
        const screenshotPath = path.join(IMAGES_DIR, outputFilename);

        try {
          await captureScreenshot(outputPath, targetSeconds, screenshotPath, quality);
          screenshotGroup.push(`/images/${outputFilename}`);
          console.log(`[Capture Screenshots] ✅ 截圖已儲存: ${outputFilename}`);
        } catch (error) {
          console.error(`[Capture Screenshots] ❌ 截圖失敗:`, error.message);
        }
      }

      if (screenshotGroup.length > 0) {
        imageUrls.push(screenshotGroup);
      }
    }

    console.log(`[Capture Screenshots] ✅ 截圖完成，共 ${imageUrls.length} 組`);
    console.log(`========== 截圖完成 ==========\n`);

    res.json({
      success: true,
      image_urls: imageUrls,
      screenshotsCount: imageUrls.length
    });

  } catch (error) {
    console.error('[Capture Screenshots] Error:', error);
    res.status(500).json({
      error: 'Failed to capture screenshots',
      details: error.message
    });
  }
});

/**
 * 從任意 URL 生成文章（異步版本）
 * POST /api/generate-article-from-url-async
 * Body: { url: string, prompt: string, uploadedFiles?: any[], templateId?: string, referenceUrls?: string[], referenceVideos?: string[] }
 */
app.post('/api/generate-article-from-url-async', async (req, res) => {
  const {
    url,
    prompt,
    uploadedFiles = [],
    templateId = 'default',
    colorTheme = 'neutral',
    referenceUrls = [],
    referenceVideos = []
  } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing url' });
  }

  // 驗證 URL 格式
  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    // 創建任務
    const taskId = taskQueue.createTask('generate-article-from-url', {
      url,
      prompt,
      uploadedFiles,
      templateId,
      referenceUrls,
      referenceVideos
    });

    // 立即返回任務 ID
    res.json({
      success: true,
      taskId,
      message: '任務已建立，請使用 taskId 查詢進度'
    });

    // 在背景執行任務
    taskQueue.executeTask(taskId, async (taskId) => {
      console.log(`\n========== 📝 [Task ${taskId}] 使用純網址生成文章 ==========`);
      console.log(`[Article URL-Only] URL: ${url}`);
      console.log(`[Article URL-Only] Template: ${templateId}`);

      if (uploadedFiles.length > 0) {
        console.log(`[Article URL-Only] 📎 上傳的參考檔案: ${uploadedFiles.length} 個`);
      }

      taskQueue.updateTaskProgress(taskId, 20, '初始化 Gemini AI...');

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: GEMINI_HTTP_OPTIONS
      });

      // 生成文章
      taskQueue.updateTaskProgress(taskId, 30, '使用 URL Context 工具分析網址並生成文章...');
      console.log('[Article URL-Only] 使用 URL Context 工具分析網址並生成文章...');

      // 使用新的 prompt 生成函數，整合所有參考資料
      const { generateArticlePromptWithReferences } = await import('./services/articlePromptService.js');

      // 準備參考資料物件
      const references = {
        uploadedFiles: uploadedFiles || [],
        referenceVideos: referenceVideos || [],
        referenceUrls: referenceUrls || []
      };

      // 生成包含所有參考資料指示的完整 prompt
      const fullPrompt = await generateArticlePromptWithReferences(url, prompt, references, templateId, 'url', colorTheme);

      // 建立 parts 陣列
      const parts = [];

      // 加入使用者上傳的參考檔案
      if (uploadedFiles.length > 0) {
        console.log(`[Article URL-Only] 📎 上傳的參考檔案: ${uploadedFiles.length} 個`);
        for (const file of uploadedFiles) {
          console.log(`[Article URL-Only] 加入參考檔案: ${file.displayName} (${file.mimeType})`);
          parts.push({
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.uri
            }
          });
        }
      }

      // 加入參考影片
      if (referenceVideos && referenceVideos.length > 0) {
        console.log(`[Article URL-Only] 📎 參考影片: ${referenceVideos.length} 個`);
        for (const videoUrl of referenceVideos) {
          console.log(`[Article URL-Only] 加入參考影片: ${videoUrl}`);
          parts.push({ fileData: { fileUri: videoUrl } });
        }
      }

      // 記錄參考網址總數
      console.log(`[Article URL-Only] 📎 參考網址總數: ${referenceUrls.length} 個`);
      referenceUrls.forEach((url, index) => {
        console.log(`[Article URL-Only]   ${index + 1}. ${url}`);
      });

      // 加入完整的 prompt（已包含所有參考資料的整合指示）
      const finalPrompt = `${fullPrompt}\n\n**重要：請確保你的回應是有效的 JSON 格式，不要包含任何額外的說明文字。**`;
      parts.push({ text: finalPrompt });

      // 日誌：顯示最終的 parts 結構
      console.log(`[Article URL-Only] 📊 Parts 結構總覽:`);
      console.log(`[Article URL-Only]   - 總共 ${parts.length} 個 parts`);
      parts.forEach((part, index) => {
        if (part.fileData) {
          console.log(`[Article URL-Only]   - Part ${index + 1}: 檔案/影片 (${part.fileData.fileUri?.substring(0, 50)}...)`);
        } else if (part.text) {
          console.log(`[Article URL-Only]   - Part ${index + 1}: 文字 (長度: ${part.text.length} 字元)`);
        }
      });

      taskQueue.updateTaskProgress(taskId, 50, 'Gemini AI 正在使用 URL Context 工具分析網址內容...');

      // 添加重試機制處理 503 錯誤
      let response;
      let attempts = 0;
      const maxAttempts = 3;

      // 準備 config - 啟用 URL Context 工具
      const geminiConfig = {
        tools: [{ urlContext: {} }]
      };
      console.log(`[Article URL-Only] 🔧 已啟用 URL Context 工具`);

      while (attempts < maxAttempts) {
        try {
          response = await generateContentWithFallback(ai, {
            contents: [
              {
                role: 'user',
                parts: parts
              }
            ],
            config: geminiConfig,
          });
          break;
        } catch (error) {
          attempts++;
          if (error.status === 503 && attempts < maxAttempts) {
            const waitTime = attempts * 5;
            console.log(`[Article URL-Only] ⚠️  Gemini API 過載，${waitTime} 秒後重試（第 ${attempts}/${maxAttempts} 次）...`);
            taskQueue.updateTaskProgress(taskId, 50 + attempts * 5, `Gemini API 過載，${waitTime} 秒後重試...`);
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
          } else {
            throw error;
          }
        }
      }

      taskQueue.updateTaskProgress(taskId, 80, '解析 Gemini AI 回應...');

      // 檢查 URL Context metadata
      if (response.candidates && response.candidates[0]?.urlContextMetadata) {
        const metadata = response.candidates[0].urlContextMetadata;
        console.log(`[Article URL-Only] 🔍 URL Context Metadata:`);
        if (metadata.urlMetadata && metadata.urlMetadata.length > 0) {
          console.log(`[Article URL-Only]   ✅ 成功抓取 ${metadata.urlMetadata.length} 個網址的內容：`);
          metadata.urlMetadata.forEach((urlMeta, index) => {
            console.log(`[Article URL-Only]   - URL ${index + 1}: ${urlMeta.retrievedUrl}`);
            console.log(`[Article URL-Only]     狀態: ${urlMeta.urlRetrievalStatus}`);
          });
        } else {
          console.log(`[Article URL-Only]   ⚠️  沒有 URL metadata 資料（可能是 Gemini 沒有使用 URL Context 工具）`);
        }
      } else {
        console.log(`[Article URL-Only]   ⚠️  回應中沒有 URL Context Metadata`);
      }

      let result;
      try {
        let responseText = response.text;
        console.log(`[Article URL-Only] ✅ Gemini 回應長度: ${responseText.length} 字元`);

        // 使用工具模式時，需要提取 JSON
        console.log(`[Article URL-Only] 🔍 使用工具模式，嘗試提取 JSON...`);

        // 智能提取 JSON：從末尾往前找最後一個完整的 JSON 對象
        let jsonText = null;

        // 從末尾找最後一個 '}'
        const lastBraceIndex = responseText.lastIndexOf('}');
        if (lastBraceIndex !== -1) {
          // 往前找對應的 '{'
          let braceCount = 1;
          let startIndex = -1;

          for (let i = lastBraceIndex - 1; i >= 0; i--) {
            if (responseText[i] === '}') {
              braceCount++;
            } else if (responseText[i] === '{') {
              braceCount--;
              if (braceCount === 0) {
                startIndex = i;
                break;
              }
            }
          }

          if (startIndex !== -1) {
            jsonText = responseText.substring(startIndex, lastBraceIndex + 1);
            console.log(`[Article URL-Only] ✅ 提取最後一個完整 JSON 對象 (長度: ${jsonText.length} 字元)`);

            // 驗證是否包含必要欄位
            if (!jsonText.includes('"titleA"')) {
              console.log(`[Article URL-Only] ⚠️ 提取的 JSON 不包含 titleA，嘗試其他方法...`);
              jsonText = null;
            }
          }
        }

        // 備用方法：使用貪婪匹配
        if (!jsonText) {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            jsonText = jsonMatch[0];
            console.log(`[Article URL-Only] ✅ 使用貪婪匹配提取 JSON (長度: ${jsonText.length} 字元)`);
          } else {
            console.log(`[Article URL-Only] ⚠️ 無法找到 JSON 對象，使用原始回應`);
            jsonText = responseText;
          }
        }

        result = JSON.parse(jsonText);

        if (!result.titleA || !result.titleB || !result.titleC || !result.article_text) {
          throw new Error('Missing required fields in response');
        }

        console.log(`[Article URL-Only] ✅ 文章生成成功!`);
        console.log(`[Article URL-Only] 標題 A: ${result.titleA}`);
      } catch (parseError) {
        console.error('[Article URL-Only] ❌ JSON parsing error:', parseError.message);
        console.error('[Article URL-Only] 回應內容:', response.text.substring(0, 500));
        throw new Error(`無法解析 Gemini 回應為 JSON 格式。錯誤：${parseError.message}`);
      }

      taskQueue.updateTaskProgress(taskId, 100, '文章生成完成！');
      console.log('[Article URL-Only] ✅ 文章生成完成！');
      console.log(`========== 文章生成完成 ==========\n`);

      return {
        success: true,
        titleA: result.titleA,
        titleB: result.titleB,
        titleC: result.titleC,
        article: postprocessArticleHtml(result.article_text),
        seo_description: result.seo_description,
        image_urls: [],
        screenshots: result.screenshots || [],
        needsScreenshots: false,
        videoId: null
      };
    });

  } catch (error) {
    console.error('Task creation error:', error);
    res.status(500).json({
      error: 'Failed to create task',
      details: error.message
    });
  }
});

/**
 * 生成文章與截圖（用於非公開影片）
 * POST /api/generate-article
 * Body: { videoId: string, filePath: string, prompt: string, videoTitle: string, quality?: number }
 * 注意：filePath 是必需的，因為需要本地檔案來截圖
 */
app.post('/api/generate-article', async (req, res) => {
  const { videoId, filePath: rawFilePath2, prompt, videoTitle, templateId = 'default', colorTheme = 'neutral', referenceUrls = [], uploadedFiles = [], referenceVideos = [] } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  let filePath;
  try {
    filePath = validateFilePath(rawFilePath2);
  } catch {
    return res.status(400).json({ error: 'Invalid filePath' });
  }

  try {
    console.log(`\n========== 📝 開始生成文章（未公開影片）==========`);
    console.log(`[Article] Video ID: ${videoId}`);
    console.log(`[Article] File Path: ${filePath || '(not provided, will check Files API)'}`);
    console.log(`[Article] Video Title: ${videoTitle}`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 先檢查檔案是否已存在於 Files API
    console.log('[Article] 步驟 1/5: 檢查 Files API 中是否已有此檔案...');
    const existingFile = await findFileByDisplayName(ai, videoId);

    let uploadedFile;
    let reusedFile = false;

    if (existingFile) {
      console.log(`[Article] ✅ 找到已存在的檔案，將重複使用！`);
      console.log(`[Article] File Name: ${existingFile.name}`);
      console.log(`[Article] Display Name: ${existingFile.displayName}`);
      console.log(`[Article] File URI: ${existingFile.uri}`);
      console.log(`[Article] 跳過上傳步驟，節省時間和流量！`);
      uploadedFile = existingFile;
      reusedFile = true;

      // 刪除本地已下載的暫存檔案（如果有提供的話）
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Article] 🗑️  已刪除不需要的暫存檔案: ${filePath}`);
      }
    } else {
      // 檔案不存在於 Files API
      if (!filePath) {
        return res.status(400).json({
          error: 'File not found in Files API and no filePath provided for upload'
        });
      }

      console.log('[Article] 檔案不存在於 Files API，需要上傳...');
      console.log('[Article] 步驟 2/5: 正在上傳影片到 Gemini...');

      // 上傳影片到 Gemini（使用 videoId 作為 displayName）
      uploadedFile = await ai.files.upload({
        file: filePath,
        config: {
          mimeType: 'video/mp4',
          displayName: videoId  // 使用 videoId 作為檔案名稱，方便後續查找
        },
      });

      console.log(`[Article] ✅ 檔案已上傳`);
      console.log(`[Article] File Name (系統生成): ${uploadedFile.name}`);
      console.log(`[Article] Display Name (我們設定): ${uploadedFile.displayName}`);
      console.log(`[Article] File URI: ${uploadedFile.uri}`);
      console.log(`[Article] File State: ${uploadedFile.state}`);
    }

    // 等待檔案處理完成（新上傳或重用中的 PROCESSING 檔案）
    if (uploadedFile.state === 'PROCESSING') {
        console.log('[Article] ⏳ Gemini 正在處理影片,等待處理完成...');
        let attempts = 0;
        const maxAttempts = 60;
        let isActive = false;

        while (!isActive && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          try {
            const fetchedFile = await ai.files.get({ name: uploadedFile.name });
            if (fetchedFile) {
              const progress = Math.round(((attempts + 1) / maxAttempts) * 100);
              console.log(`[Article] 檢查狀態 ${attempts + 1}/${maxAttempts} (${progress}%) - State: ${fetchedFile.state}`);
              if (fetchedFile.state === 'ACTIVE') {
                isActive = true;
                console.log('[Article] ✅ 檔案處理完成,可以開始生成文章!');
              } else if (fetchedFile.state === 'FAILED') {
                throw new Error('File processing failed');
              }
            }
          } catch (error) {
            console.log(`[Article] ⚠️  檢查 ${attempts + 1}/${maxAttempts} 時發生錯誤: ${error.message}`);
          }
          attempts++;
        }

        if (!isActive) {
          throw new Error('File processing timeout. Please try again later.');
        }
      } else if (uploadedFile.state === 'ACTIVE') {
        console.log('[Article] ✅ 檔案已經是 ACTIVE 狀態');
      } else {
        throw new Error(`Unexpected file state: ${uploadedFile.state}`);
      }

    // 生成文章提示詞
    console.log(reusedFile ? '[Article] 步驟 3/4: 正在生成文章內容與截圖時間點...' : '[Article] 步驟 4/5: 正在生成文章內容與截圖時間點...');

    // 使用新的 prompt 生成函數，整合所有參考資料
    const { generateArticlePromptWithReferences } = await import('./services/articlePromptService.js');

    // 準備參考資料物件
    const references = {
      uploadedFiles: uploadedFiles || [],
      referenceVideos: referenceVideos || [],
      referenceUrls: referenceUrls || []
    };

    // 生成包含所有參考資料指示的完整 prompt
    const fullPrompt = await generateArticlePromptWithReferences(videoTitle, prompt, references, templateId, 'video', colorTheme);

    // 準備 config
    const geminiConfig = {};

    // 如果有參考網址，啟用 URL Context 工具
    if (referenceUrls && referenceUrls.length > 0) {
      geminiConfig.tools = [{ urlContext: {} }];
      console.log(`[Article] 🔧 已啟用 URL Context 工具（無法使用 responseMimeType）`);
    } else {
      // 只有在沒有使用工具時才能指定 responseMimeType
      geminiConfig.responseMimeType = "application/json";
    }

    // 建立 parts 陣列
    const parts = [
      { fileData: { fileUri: uploadedFile.uri, mimeType: 'video/mp4' } }
    ];

    // 加入使用者上傳的參考檔案
    if (uploadedFiles.length > 0) {
      console.log(`[Article] 📎 上傳的參考檔案: ${uploadedFiles.length} 個`);
      for (const file of uploadedFiles) {
        console.log(`[Article] 加入參考檔案: ${file.displayName} (${file.mimeType})`);
        parts.push({
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri
          }
        });
      }
    }

    // 加入參考影片
    if (referenceVideos && referenceVideos.length > 0) {
      console.log(`[Article] 📎 參考影片: ${referenceVideos.length} 個`);
      for (const videoUrl of referenceVideos) {
        console.log(`[Article] 加入參考影片: ${videoUrl}`);
        parts.push({ fileData: { fileUri: videoUrl } });
      }
    }

    // 記錄參考網址數量
    if (referenceUrls && referenceUrls.length > 0) {
      console.log(`[Article] 📎 參考網址: ${referenceUrls.length} 個`);
    }

    // 加入完整的 prompt（已包含所有參考資料的整合指示）
    const finalPrompt = `${fullPrompt}\n\n**重要：請確保你的回應是有效的 JSON 格式，不要包含任何額外的說明文字。**`;
    parts.push({ text: finalPrompt });

    // 日誌：顯示最終的 parts 結構
    console.log(`[Article] 📊 Parts 結構總覽:`);
    console.log(`[Article]   - 總共 ${parts.length} 個 parts`);
    parts.forEach((part, index) => {
      if (part.fileData) {
        console.log(`[Article]   - Part ${index + 1}: 檔案/影片 (${part.fileData.fileUri?.substring(0, 50)}...)`);
      } else if (part.text) {
        console.log(`[Article]   - Part ${index + 1}: 文字 (長度: ${part.text.length} 字元)`);
      }
    });
    if (geminiConfig.tools) {
      console.log(`[Article] 🔧 已啟用工具: ${JSON.stringify(geminiConfig.tools)}`);
    }

    // 呼叫 Gemini API 生成文章與截圖時間點
    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: parts
        }
      ],
      config: geminiConfig,
    });

    // 檢查 URL Context metadata
    if (response.candidates && response.candidates[0]?.urlContextMetadata) {
      const metadata = response.candidates[0].urlContextMetadata;
      console.log(`[Article] 🔍 URL Context Metadata:`);
      if (metadata.urlMetadata && metadata.urlMetadata.length > 0) {
        console.log(`[Article]   ✅ 成功抓取 ${metadata.urlMetadata.length} 個網址的內容：`);
        metadata.urlMetadata.forEach((urlMeta, index) => {
          console.log(`[Article]   - URL ${index + 1}: ${urlMeta.retrievedUrl}`);
          console.log(`[Article]     狀態: ${urlMeta.urlRetrievalStatus}`);
        });
      } else {
        console.log(`[Article]   ⚠️  沒有 URL metadata 資料（可能是 Gemini 沒有使用 URL Context 工具）`);
      }
    } else {
      console.log(`[Article]   ⚠️  回應中沒有 URL Context Metadata`);
    }

    let result;
    try {
      let responseText = response.text;
      console.log(`[Article] ✅ Gemini 回應長度: ${responseText.length} 字元`);
      console.log(`[Article] 回應預覽: ${responseText.substring(0, 150)}...`);

      // 當使用工具時，可能需要提取 JSON
      if (referenceUrls && referenceUrls.length > 0) {
        console.log(`[Article] 🔍 使用工具模式，嘗試提取 JSON...`);
        // 嘗試找到 JSON 對象
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          responseText = jsonMatch[0];
          console.log(`[Article] ✅ 成功提取 JSON (長度: ${responseText.length} 字元)`);
        } else {
          console.log(`[Article] ⚠️ 無法找到 JSON 對象，使用原始回應`);
        }
      }

      result = parseGeminiJson(responseText);
      // 驗證必要欄位
      if (!result.titleA || !result.titleB || !result.titleC || !result.article_text || !result.screenshots) {
        throw new Error('Missing required fields in response');
      }

      console.log(`[Article] ✅ 文章生成成功! 找到 ${result.screenshots.length} 個截圖時間點`);
      console.log(`[Article] 標題 A: ${result.titleA}`);
    } catch (parseError) {
      console.error('[Article] ❌ JSON parsing error:', parseError.message);
      console.error('[Article] 回應內容:', response.text.substring(0, 500));

      // 嘗試找出問題位置
      const lines = response.text.split('\n');
      console.error(`[Article] Response has ${lines.length} lines`);

      throw new Error(`無法解析 Gemini 回應為 JSON 格式。錯誤：${parseError.message}`);
    }

    // 不執行截圖，保留影片檔案供後續 /api/capture-screenshots 使用
    console.log(`[Article] ✅ 文章生成完成！截圖時間點已規劃`);
    console.log(`[Article] ℹ️  如需截圖，請使用「截圖」按鈕（需要本地環境或支援 yt-dlp 的環境）`);
    console.log(`[Article] 暫存檔案保留供截圖使用: ${filePath}`);
    console.log(`========== 文章生成完成 ==========\n`);

    res.json({
      success: true,
      titleA: result.titleA,
      titleB: result.titleB,
      titleC: result.titleC,
      article: postprocessArticleHtml(result.article_text),
      seo_description: result.seo_description,
      image_urls: [], // 尚未截圖
      screenshots: result.screenshots,
      needsScreenshots: true, // 標記需要截圖
      videoId: videoId, // 用於後續截圖
      geminiFileName: uploadedFile.name,
      geminiFileUri: uploadedFile.uri
    });

  } catch (error) {
    console.error('Article generation error:', error);

    res.status(500).json({
      error: 'Failed to generate article',
      details: error.message
    });
  }
});

/**
 * 使用現有 Gemini 檔案重新生成文章
 * POST /api/regenerate-article
 * Body: { videoId: string, geminiFileName: string, prompt: string, videoTitle: string }
 */
app.post('/api/regenerate-article', async (req, res) => {
  const { videoId, geminiFileName, prompt, videoTitle } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  if (!geminiFileName) {
    return res.status(400).json({ error: 'Missing required parameter: geminiFileName' });
  }

  try {
    console.log(`Regenerating article using existing file: ${geminiFileName}`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 檢查檔案是否存在
    let fileInfo;
    try {
      fileInfo = await ai.files.get({ name: geminiFileName });
    } catch (error) {
      console.log(`File not found: ${error.message}`);
      return res.status(404).json({
        error: 'File not found in Gemini',
        needsRedownload: true
      });
    }

    if (fileInfo.state !== 'ACTIVE') {
      return res.status(400).json({
        error: 'File is not ready',
        state: fileInfo.state
      });
    }

    console.log(`✅ File found and active: ${fileInfo.uri}`);

    // 生成文章提示詞
    const fullPrompt = generateArticlePrompt(videoTitle, prompt);

    // 呼叫 Gemini API
    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: fileInfo.uri, mimeType: 'video/mp4' } },
            { text: fullPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,  // 設定較高的 token 上限，避免生成結果被截斷
      },
    });

    let result;
    try {
      const responseText = response.text;
      console.log('Response length:', responseText.length);
      console.log('Response preview:', responseText.substring(0, 200));

      result = parseGeminiJson(responseText);

      // 驗證必要欄位
      if (!result.titleA || !result.titleB || !result.titleC || !result.article_text || !result.screenshots) {
        throw new Error('Missing required fields in response');
      }

      console.log(`Article regenerated successfully. Found ${result.screenshots.length} screenshots.`);
    } catch (parseError) {
      console.error('❌ JSON parsing error:', parseError.message);
      console.error('Full response text:', response.text);

      throw new Error(`無法解析 Gemini 回應為 JSON 格式。錯誤：${parseError.message}`);
    }

    // 注意：重新生成時無法截圖（因為沒有本地影片檔案）
    // 需要使用者重新下載影片才能截圖
    res.json({
      success: true,
      titleA: result.titleA,
      titleB: result.titleB,
      titleC: result.titleC,
      article: postprocessArticleHtml(result.article_text),
      seo_description: result.seo_description,
      screenshots: result.screenshots,
      geminiFileName: fileInfo.name,
      geminiFileUri: fileInfo.uri,
      reusedExistingFile: true,
      note: 'Screenshots not captured. Please re-download video to generate screenshots.'
    });

  } catch (error) {
    console.error('Article regeneration error:', error);
    res.status(500).json({
      error: 'Failed to regenerate article',
      details: error.message
    });
  }
});

/**
 * 重新生成截圖（讓 Gemini 重新看影片並提供新的截圖建議）
 * POST /api/regenerate-screenshots
 * Body: { videoId: string, videoTitle: string, filePath: string, prompt?: string, quality?: number }
 */
app.post('/api/regenerate-screenshots', async (req, res) => {
  const { videoId, videoTitle, filePath: rawFilePath3, prompt, quality = 2 } = req.body;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Missing or invalid videoId format' });
  }

  if (!videoTitle || !rawFilePath3) {
    return res.status(400).json({ error: 'Missing required parameters: videoTitle, filePath' });
  }

  let filePath;
  try {
    filePath = validateFilePath(rawFilePath3);
  } catch {
    return res.status(400).json({ error: 'Invalid filePath' });
  }

  try {
    console.log(`\n========== 🔄 重新生成截圖 ==========`);
    console.log(`[Regenerate Screenshots] Video ID: ${videoId}`);
    console.log(`[Regenerate Screenshots] File Path: ${filePath}`);
    console.log(`[Regenerate Screenshots] Video Title: ${videoTitle}`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 步驟 1: 檢查 Files API 中是否有此檔案
    console.log('[Regenerate Screenshots] 步驟 1/4: 檢查 Files API 中是否已有此檔案...');
    const filesList = await ai.files.list();
    const files = filesList.pageInternal || [];
    const existingFile = files.find(file =>
      file.displayName === videoId && file.state === 'ACTIVE'
    );

    if (!existingFile) {
      return res.status(404).json({ error: 'Video file not found in Files API. Please generate article first.' });
    }

    console.log(`[Regenerate Screenshots] ✅ 找到已存在的檔案: ${existingFile.uri}`);

    // 步驟 2: 讓 Gemini 重新看影片並生成新的截圖建議
    console.log('[Regenerate Screenshots] 步驟 2/4: 讓 Gemini 重新分析影片並提供新的截圖建議...');
    const fullPrompt = generateArticlePrompt(videoTitle, prompt || '');

    // 根據最佳實踐：影片應該放在 prompt 之前
    const response = await generateContentWithFallback(ai, {
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: existingFile.uri, mimeType: 'video/mp4' } },
            { text: fullPrompt }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    let result;
    try {
      const responseText = response.text;
      result = parseGeminiJson(responseText);
    } catch (parseError) {
      console.error('[Regenerate Screenshots] ❌ JSON parsing error:', parseError.message);
      throw new Error(`無法解析 Gemini 回應為 JSON 格式。錯誤：${parseError.message}`);
    }

    // 步驟 3: 使用本地影片進行截圖
    console.log('[Regenerate Screenshots] 步驟 3/4: 正在截取新的關鍵畫面...');
    console.log(`[Regenerate Screenshots] 截圖品質設定: ${quality} (2=最高, 31=最低)`);

    const imageUrls = [];
    for (let i = 0; i < result.screenshots.length; i++) {
      const screenshot = result.screenshots[i];
      const timestamp = screenshot.timestamp_seconds;
      const currentSeconds = timeToSeconds(timestamp);

      const screenshotGroup = [];
      const offsets = [
        { offset: -2, label: 'before' },
        { offset: 0, label: 'current' },
        { offset: 2, label: 'after' }
      ];

      console.log(`[Regenerate Screenshots] 截圖組 ${i + 1}/${result.screenshots.length} - 時間點: ${timestamp} - 原因: ${screenshot.reason_for_screenshot}`);

      for (const { offset, label } of offsets) {
        const targetSeconds = Math.max(0, currentSeconds + offset);
        const targetTime = secondsToTime(targetSeconds); // 僅用於檔名

        const outputFilename = `${videoId}_screenshot_${i}_${label}_${targetTime.replace(':', '-')}.jpg`;
        const outputPath = path.join(IMAGES_DIR, outputFilename);

        try {
          await captureScreenshot(filePath, targetSeconds, outputPath, quality);
          screenshotGroup.push(`/images/${outputFilename}`);
          console.log(`[Regenerate Screenshots] ✅ 截圖已儲存: ${outputFilename} (${label}: ${targetSeconds}s)`);
        } catch (error) {
          console.error(`[Regenerate Screenshots] ❌ 截圖失敗 (時間點 ${targetSeconds}s, ${label}):`, error.message);
        }
      }

      if (screenshotGroup.length > 0) {
        imageUrls.push(screenshotGroup);
      }
    }

    // 步驟 4: 完成（保留暫存檔案供後續使用）
    console.log(`[Regenerate Screenshots] ✅ 已完成截圖，暫存檔案保留: ${filePath}`);
    console.log(`========== 重新截圖完成 ==========\n`);

    res.json({
      success: true,
      titleA: result.titleA,
      titleB: result.titleB,
      titleC: result.titleC,
      article: postprocessArticleHtml(result.article_text),
      seo_description: result.seo_description,
      image_urls: imageUrls,
      screenshots: result.screenshots,
    });

  } catch (error) {
    console.error('Regenerate screenshots error:', error);

    res.status(500).json({
      error: 'Failed to regenerate screenshots',
      details: error.message
    });
  }
});

/**
 * 檢查 Files API 中是否存在指定 videoId 的檔案
 * GET /api/check-file/:videoId
 */
app.get('/api/check-file/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  try {
    console.log(`[Check File] Checking if file exists for videoId: ${videoId}`);
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: GEMINI_HTTP_OPTIONS
    });

    // 列出所有檔案，尋找符合 displayName 的檔案
    console.log(`[Check File] Calling ai.files.list()...`);
    const matchingFile = await findFileByDisplayName(ai, videoId);

    if (matchingFile) {
      console.log(`[Check File] ✅ Found file: ${matchingFile.name}, State: ${matchingFile.state}`);

      // 檢查檔案狀態
      if (matchingFile.state === 'ACTIVE') {
        return res.json({
          exists: true,
          file: {
            name: matchingFile.name,
            uri: matchingFile.uri,
            state: matchingFile.state,
            displayName: matchingFile.displayName,
            createTime: matchingFile.createTime,
            expirationTime: matchingFile.expirationTime
          }
        });
      } else if (matchingFile.state === 'PROCESSING') {
        return res.json({
          exists: true,
          processing: true,
          file: {
            name: matchingFile.name,
            state: matchingFile.state,
            displayName: matchingFile.displayName
          }
        });
      } else {
        // 檔案存在但狀態不是 ACTIVE 或 PROCESSING（可能是 FAILED）
        return res.json({
          exists: false,
          reason: `File exists but state is ${matchingFile.state}`
        });
      }
    }

    console.log(`[Check File] ❌ No file found for videoId: ${videoId}`);
    res.json({ exists: false });

  } catch (error) {
    console.error('[Check File] Error:', error);
    res.status(500).json({
      error: 'Failed to check file',
      details: error.message
    });
  }
});

/**
 * 清理暫存檔案
 * DELETE /api/cleanup/:videoId
 */
app.delete('/api/cleanup/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  const filePath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up: ${filePath}`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// ==================== AI 頻道分析 API ====================

/**
 * 獲取可用的 AI 模型列表
 * GET /api/ai-models/available
 */
app.get('/api/ai-models/available', async (req, res) => {
  try {
    const models = aiManager.getAvailableModels();

    res.json({
      success: true,
      models,
      count: models.length,
    });
  } catch (error) {
    console.error('[AI Models] 獲取模型列表失敗:', error);
    res.status(500).json({
      success: false,
      error: '獲取模型列表失敗',
      details: error.message,
    });
  }
});

/**
 * 檢查特定模型狀態
 * GET /api/ai-models/:modelId/status
 */
app.get('/api/ai-models/:modelId/status', async (req, res) => {
  try {
    const { modelId } = req.params;
    const status = await aiManager.getModelStatus(modelId);

    res.json({
      success: true,
      modelId,
      status,
    });
  } catch (error) {
    console.error('[AI Models] 檢查模型狀態失敗:', error);
    res.status(500).json({
      success: false,
      error: '檢查模型狀態失敗',
      details: error.message,
    });
  }
});

/**
 * 獲取推薦模型
 * GET /api/ai-models/recommend?analysisType=subscriber-growth
 */
app.get('/api/ai-models/recommend', (req, res) => {
  try {
    const { analysisType } = req.query;

    if (!analysisType) {
      return res.status(400).json({
        success: false,
        error: '缺少 analysisType 參數',
      });
    }

    const recommendedModel = aiManager.getRecommendedModel(analysisType);

    if (!recommendedModel) {
      return res.status(404).json({
        success: false,
        error: '沒有可用的推薦模型',
        suggestion: '請檢查 API Key 配置',
      });
    }

    res.json({
      success: true,
      analysisType,
      recommendedModel,
    });
  } catch (error) {
    console.error('[AI Models] 獲取推薦模型失敗:', error);
    res.status(500).json({
      success: false,
      error: '獲取推薦模型失敗',
      details: error.message,
    });
  }
});

/**
 * AI 頻道分析（支援多模型、多分析類型）
 * POST /api/analyze-channel
 */
app.post('/api/analyze-channel', async (req, res) => {
  const {
    startDate,
    endDate,
    channelId,
    videos,
    channelStats,
    analytics,
    modelType = 'gemini-flash-latest', // 默認使用 Gemini Flash
    analysisType = 'comprehensive', // 默認使用綜合分析
  } = req.body;

  // 驗證輸入
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Missing startDate or endDate' });
  }

  if (!videos || !Array.isArray(videos)) {
    return res.status(400).json({ error: 'Missing or invalid videos array' });
  }

  try {
    console.log(`\n========== 📊 開始分析頻道表現 ==========`);
    console.log(`[Channel Analysis] 模型: ${modelType}`);
    console.log(`[Channel Analysis] 分析類型: ${analysisType}`);
    console.log(`[Channel Analysis] 日期範圍: ${startDate} ~ ${endDate}`);
    console.log(`[Channel Analysis] 影片數量: ${videos.length}`);

    // 生成分析 Prompt
    const prompt = PromptTemplates.generatePrompt({
      type: analysisType,
      dateRange: { startDate, endDate },
      channelStats,
      videos,
      analytics,
    });

    console.log('[Channel Analysis] 📤 發送請求到 AI 模型...');

    // 使用 AI 模型管理器進行分析
    const response = await aiManager.analyze(modelType, {
      prompt,
      temperature: 0.7,
      maxTokens: getMaxTokensForModel(modelType),
    });

    console.log('[Channel Analysis] ✅ 分析完成');
    console.log(`[Channel Analysis] 模型: ${response.model}`);
    console.log(`[Channel Analysis] 提供者: ${response.provider}`);
    console.log(
      `[Channel Analysis] Token 使用: ${response.usage?.totalTokens || 'N/A'}`
    );
    if (response.cost) {
      console.log(`[Channel Analysis] 成本: $${response.cost.toFixed(6)}`);
    }
    console.log(`[Channel Analysis] 結果長度: ${response.text.length} 字元`);

    res.json({
      success: true,
      analysis: response.text,
      metadata: {
        model: response.model,
        provider: response.provider,
        analysisType,
        usage: response.usage,
        cost: response.cost,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[Channel Analysis] ❌ 分析失敗:', error);
    res.status(500).json({
      success: false,
      error: '頻道分析失敗',
      details: error.message,
    });
  }
});

/**
 * 頻道分析（SSE 串流版）
 * POST /api/analyze-channel/stream
 */
app.post('/api/analyze-channel/stream', async (req, res) => {
  const {
    startDate,
    endDate,
    channelId,
    videos,
    channelStats,
    analytics,
    modelType = 'gemini-flash-latest',
    analysisType = 'comprehensive',
  } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    sendEvent('ping', {});
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
  };

  const abortController = new AbortController();
  req.on('close', () => {
    abortController.abort();
    cleanup();
  });

  try {
    if (!startDate || !endDate) {
      throw new Error('Missing startDate or endDate');
    }

    if (!videos || !Array.isArray(videos)) {
      throw new Error('Missing or invalid videos array');
    }

    sendEvent('stage', { id: 'prepare', status: 'active' });

    const prompt = PromptTemplates.generatePrompt({
      type: analysisType,
      dateRange: { startDate, endDate },
      channelStats,
      videos,
      analytics,
    });

    sendEvent('stage', { id: 'prepare', status: 'completed' });
    sendEvent('stage', { id: 'request', status: 'active' });

    let finalResult = null;

    await aiManager.streamAnalyze(
      modelType,
      {
        prompt,
        temperature: 0.7,
        maxTokens: getMaxTokensForModel(modelType),
        abortSignal: abortController.signal,
      },
      {
        onChunk: (text) => {
          if (text) {
            sendEvent('chunk', { text });
          }
        },
        onComplete: (result) => {
          finalResult = result;
        },
      }
    );

    sendEvent('stage', { id: 'request', status: 'completed' });
    sendEvent('stage', { id: 'render', status: 'active' });

    if (!finalResult) {
      throw new Error('分析結果為空');
    }

    sendEvent('complete', {
      text: finalResult.text,
      metadata: {
        model: finalResult.model,
        provider: finalResult.provider,
        usage: finalResult.usage,
        cost: finalResult.cost,
        finishReason: finalResult.finishReason,
        analysisType,
        timestamp: new Date().toISOString(),
      },
    });

    sendEvent('stage', { id: 'render', status: 'completed' });
    sendEvent('end', { success: true });
    cleanup();
    res.end();
  } catch (error) {
    const isAbortError =
      error.name === 'AbortError' ||
      (typeof error.message === 'string' && error.message.includes('串流已中止'));

    if (!isAbortError) {
      console.error('[Channel Analysis SSE] ❌ 串流分析失敗:', error);
      sendEvent('error', {
        message: error.message || '串流分析失敗',
      });
    } else {
      console.warn('[Channel Analysis SSE] 串流被中止');
    }
    cleanup();
    res.end();
  }
});

/**
 * 多模型協同分析
 * POST /api/analyze-channel/multi-model
 */
app.post('/api/analyze-channel/multi-model', async (req, res) => {
  const {
    startDate,
    endDate,
    channelId,
    videos,
    channelStats,
    analytics,
    models, // 用戶指定的模型列表
  } = req.body;

  try {
    console.log(`\n========== 📊 開始多模型協同分析 ==========`);

    // 如果沒有指定模型，使用所有可用模型
    let modelsToUse = models;
    if (!modelsToUse || modelsToUse.length === 0) {
      const availableModels = aiManager.getAvailableModels();
      modelsToUse = availableModels.map((m) => m.id);
    }

    console.log(`[Multi-Model Analysis] 使用模型: ${modelsToUse.join(', ')}`);

    // 並行執行多個模型分析
    const analysisPromises = modelsToUse.map(async (modelType) => {
      try {
        const prompt = PromptTemplates.generatePrompt({
          type: 'comprehensive',
          dateRange: { startDate, endDate },
          channelStats,
          videos,
          analytics,
        });

        const response = await aiManager.analyze(modelType, {
          prompt,
          temperature: 0.7,
          maxTokens: getMaxTokensForModel(modelType),
        });

        return {
          model: response.model,
          provider: response.provider,
          analysis: response.text,
          usage: response.usage,
          cost: response.cost,
          success: true,
        };
      } catch (error) {
        console.error(`[Multi-Model Analysis] ${modelType} 分析失敗:`, error);
        return {
          model: modelType,
          error: error.message,
          success: false,
        };
      }
    });

    const results = await Promise.all(analysisPromises);

    const successCount = results.filter((r) => r.success).length;
    const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);

    console.log('[Multi-Model Analysis] ✅ 分析完成');
    console.log(`[Multi-Model Analysis] 成功: ${successCount}/${results.length}`);
    if (totalCost > 0) {
      console.log(`[Multi-Model Analysis] 總成本: $${totalCost.toFixed(6)}`);
    }

    res.json({
      success: true,
      results,
      summary: {
        total: results.length,
        successful: successCount,
        failed: results.length - successCount,
        totalCost,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Multi-Model Analysis] ❌ 分析失敗:', error);
    res.status(500).json({
      success: false,
      error: '多模型分析失敗',
      details: error.message,
    });
  }
});

/**
 * AI 關鍵字報表分析（支援多模型）
 * POST /api/analyze-keywords
 */
app.post('/api/analyze-keywords', async (req, res) => {
  const {
    keywordGroups,      // 關鍵字組合列表
    dateColumns,        // 日期列列表
    analyticsData,      // 分析數據（{ groupId: { columnId: { views, likes, ... } } }）
    selectedMetrics,    // 選中的指標
    modelType = 'gemini-flash-latest', // 使用的模型
  } = req.body;

  const kwRate = checkRateLimit(req.user?.email || req.ip, aiRateLimiter, MAX_AI_REQUESTS_PER_HOUR);
  if (!kwRate.allowed) {
    return res.status(429).json({ success: false, error: `請求過於頻繁，請於 ${kwRate.waitMinutes} 分鐘後再試` });
  }

  try {
    console.log(`\n========== 🔍 開始關鍵字報表分析 ==========`);
    console.log(`[Keyword Analysis] 模型: ${modelType}`);
    console.log(`[Keyword Analysis] 關鍵字組合數: ${keywordGroups?.length || 0}`);
    console.log(`[Keyword Analysis] 日期列數: ${dateColumns?.length || 0}`);

    // 驗證必要參數
    if (!keywordGroups || keywordGroups.length === 0) {
      return res.status(400).json({
        success: false,
        error: '請提供至少一個關鍵字組合',
      });
    }

    if (!dateColumns || dateColumns.length === 0) {
      return res.status(400).json({
        success: false,
        error: '請提供至少一個日期範圍',
      });
    }

    if (!analyticsData) {
      return res.status(400).json({
        success: false,
        error: '請提供分析數據',
      });
    }

    // 生成關鍵字分析 Prompt
    const prompt = PromptTemplates.buildContentUnitPrompt({
      keywordGroups,
      dateColumns,
      analyticsData,
      selectedMetrics: selectedMetrics || ['views', 'likes', 'comments'],
    });

    console.log('[Keyword Analysis] 📤 發送請求到 AI 模型...');

    // 調用 AI 模型分析
    const response = await aiManager.analyze(modelType, {
      prompt,
      temperature: 0.7,
      maxTokens: getMaxTokensForModel(modelType),
    });

    console.log('[Keyword Analysis] ✅ 分析完成');
    console.log(`[Keyword Analysis] 模型: ${response.model}`);
    console.log(`[Keyword Analysis] 提供者: ${response.provider}`);
    if (response.usage) {
      console.log(`[Keyword Analysis] Token 使用: ${response.usage.totalTokens || 'N/A'}`);
    }
    if (response.cost) {
      console.log(`[Keyword Analysis] 成本: $${response.cost.toFixed(6)}`);
    }
    console.log(`[Keyword Analysis] 結果長度: ${response.text?.length || 0} 字元`);

    res.json({
      success: true,
      analysis: response.text,
      metadata: {
        model: response.model,
        provider: response.provider,
        usage: response.usage,
        cost: response.cost,
        keywordGroupCount: keywordGroups.length,
        dateColumnCount: dateColumns.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[Keyword Analysis] ❌ 分析失敗:', error);
    res.status(500).json({
      success: false,
      error: '關鍵字分析失敗',
      details: error.message,
    });
  }
});

/**
 * AI 關鍵字報表分析（SSE 串流版）
 * POST /api/analyze-keywords/stream
 */
app.post('/api/analyze-keywords/stream', async (req, res) => {
  const {
    keywordGroups,
    dateColumns,
    analyticsData,
    selectedMetrics,
    modelType = 'gemini-flash-latest',
  } = req.body;

  const kwStreamRate = checkRateLimit(req.user?.email || req.ip, aiRateLimiter, MAX_AI_REQUESTS_PER_HOUR);
  if (!kwStreamRate.allowed) {
    return res.status(429).json({ success: false, error: `請求過於頻繁，請於 ${kwStreamRate.waitMinutes} 分鐘後再試` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    sendEvent('ping', {});
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
  };

  const abortController = new AbortController();
  req.on('close', () => {
    abortController.abort();
    cleanup();
  });

  const failAndEnd = (message) => {
    sendEvent('error', { message });
    sendEvent('end', { success: false });
    cleanup();
    res.end();
  };

  try {
    if (!keywordGroups || keywordGroups.length === 0) {
      return failAndEnd('請提供至少一個關鍵字組合');
    }
    if (!dateColumns || dateColumns.length === 0) {
      return failAndEnd('請提供至少一個日期範圍');
    }
    if (!analyticsData) {
      return failAndEnd('請提供分析數據');
    }

    sendEvent('stage', { id: 'prepare', status: 'active' });

    const prompt = PromptTemplates.buildContentUnitPrompt({
      keywordGroups,
      dateColumns,
      analyticsData,
      selectedMetrics: selectedMetrics || ['views', 'likes', 'comments'],
    });

    sendEvent('stage', { id: 'prepare', status: 'completed' });
    sendEvent('stage', { id: 'request', status: 'active' });

    let finalResult = null;

    await aiManager.streamAnalyze(
      modelType,
      {
        prompt,
        temperature: 0.7,
        maxTokens: getMaxTokensForModel(modelType),
        abortSignal: abortController.signal,
      },
      {
        onChunk: (text) => {
          if (text) {
            sendEvent('chunk', { text });
          }
        },
        onComplete: (result) => {
          finalResult = result;
        },
      }
    );

    sendEvent('stage', { id: 'request', status: 'completed' });
    sendEvent('stage', { id: 'render', status: 'active' });

    if (!finalResult) {
      throw new Error('分析結果為空');
    }

    sendEvent('complete', {
      text: finalResult.text,
      metadata: {
        model: finalResult.model,
        provider: finalResult.provider,
        usage: finalResult.usage,
        cost: finalResult.cost,
        keywordGroupCount: keywordGroups.length,
        dateColumnCount: dateColumns.length,
        selectedMetricsCount: selectedMetrics?.length || 0,
        timestamp: new Date().toISOString(),
      },
    });

    sendEvent('stage', { id: 'render', status: 'completed' });
    sendEvent('end', { success: true });
    cleanup();
    res.end();
  } catch (error) {
    const isAbortError =
      error.name === 'AbortError' ||
      (typeof error.message === 'string' && error.message.includes('串流'));

    if (!isAbortError) {
      console.error('[Keyword Analysis SSE] ❌ 串流分析失敗:', error);
      failAndEnd(error.message || '串流分析失敗');
    } else {
      console.warn('[Keyword Analysis SSE] 串流被中止');
      cleanup();
      res.end();
    }
  }
});

/**
 * 頻道數據聚合（支援關鍵字過濾和多個日期範圍）
 * POST /api/channel-analytics/aggregate
 */
app.post('/api/channel-analytics/aggregate', async (req, res) => {
  try {
    const { accessToken, channelId, keywordGroups, dateRanges } = req.body;

    // 驗證參數
    if (!accessToken) {
      return res.status(400).json({ error: '缺少 accessToken' });
    }

    if (!channelId) {
      return res.status(400).json({ error: '缺少 channelId' });
    }

    if (!keywordGroups || !Array.isArray(keywordGroups) || keywordGroups.length === 0) {
      return res.status(400).json({ error: '缺少 keywordGroups 或格式錯誤' });
    }

    if (!dateRanges || !Array.isArray(dateRanges) || dateRanges.length === 0) {
      return res.status(400).json({ error: '缺少 dateRanges 或格式錯誤' });
    }

    // 驗證 keywordGroups 格式
    for (const group of keywordGroups) {
      if (!group.name || typeof group.name !== 'string') {
        return res.status(400).json({ error: 'keywordGroups 中的 name 必須為字符串' });
      }
      if (typeof group.keyword !== 'string') {
        return res.status(400).json({ error: 'keywordGroups 中的 keyword 必須為字符串' });
      }
    }

    // 驗證 dateRanges 格式
    for (const range of dateRanges) {
      if (!range.label || typeof range.label !== 'string') {
        return res.status(400).json({ error: 'dateRanges 中的 label 必須為字符串' });
      }
      if (!range.startDate || typeof range.startDate !== 'string') {
        return res.status(400).json({ error: 'dateRanges 中的 startDate 必須為字符串 (YYYY-MM-DD)' });
      }
      if (!range.endDate || typeof range.endDate !== 'string') {
        return res.status(400).json({ error: 'dateRanges 中的 endDate 必須為字符串 (YYYY-MM-DD)' });
      }
    }

    console.log('\n========== 📊 開始聚合頻道數據 ==========');
    console.log(`[Channel Analytics] 頻道 ID: ${channelId}`);
    console.log(`[Channel Analytics] 關鍵字組合數: ${keywordGroups.length}`);
    console.log(`[Channel Analytics] 日期範圍數: ${dateRanges.length}`);

    const result = await aggregateChannelData(
      accessToken,
      channelId,
      keywordGroups,
      dateRanges
    );

    console.log('[Channel Analytics] ✅ 數據聚合完成');
    res.json(result);
  } catch (error) {
    console.error('[Channel Analytics] ❌ 數據聚合失敗:', error);
    res.status(500).json({
      error: error.message || '數據聚合失敗',
      details: error.toString(),
    });
  }
});

/**
 * 清除數據聚合快取
 * POST /api/channel-analytics/clear-cache
 */
app.post('/api/channel-analytics/clear-cache', (_req, res) => {
  try {
    const result = clearAnalyticsCache();
    res.json({
      success: true,
      message: `已清除 ${result.cleared} 筆快取`,
      cleared: result.cleared,
    });
  } catch (error) {
    console.error('[Channel Analytics] ❌ 清除快取失敗:', error);
    res.status(500).json({
      error: error.message || '清除快取失敗',
    });
  }
});

/**
 * 影片表現分析 API
 * POST /api/analytics/channel
 * 分析頻道影片表現，找出需要優化的影片
 */
app.post('/api/analytics/channel', async (req, res) => {
  try {
    const { accessToken, channelId, daysThreshold = 365 } = req.body;

    // 驗證必要參數
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: '缺少 accessToken',
      });
    }

    if (!channelId) {
      return res.status(400).json({
        success: false,
        message: '缺少 channelId',
      });
    }

    console.log(`\n========== 📊 開始影片表現分析 ==========`);
    console.log(`[Video Analytics] 頻道 ID: ${channelId}`);
    console.log(`[Video Analytics] 天數範圍: ${daysThreshold} 天`);

    // 步驟 1: 獲取頻道影片分析數據
    const analyticsData = await getChannelVideosAnalytics(accessToken, channelId, daysThreshold);
    console.log(`[Video Analytics] 獲取到 ${analyticsData.length} 支影片的分析數據`);

    // 步驟 2: 計算更新優先級
    const recommendations = calculateUpdatePriority(analyticsData);
    console.log(`[Video Analytics] 找到 ${recommendations.length} 支建議更新的影片`);

    res.json({
      success: true,
      totalVideos: analyticsData.length,
      recommendations: recommendations,
    });
  } catch (error) {
    console.error('[Video Analytics] ❌ 分析失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '影片表現分析失敗',
    });
  }
});

/**
 * 關鍵字分析 API
 * POST /api/analytics/keyword-analysis
 * 使用 AI 分析影片關鍵字並提供優化建議
 */
app.post('/api/analytics/keyword-analysis', async (req, res) => {
  try {
    const kwRate = checkRateLimit(req.user?.email || req.ip, aiRateLimiter, MAX_AI_REQUESTS_PER_HOUR);
    if (!kwRate.allowed) {
      return res.status(429).json({ success: false, message: `請求過於頻繁，請於 ${kwRate.waitMinutes} 分鐘後再試` });
    }

    const { videoData } = req.body;

    // 驗證必要參數
    if (!videoData || !videoData.title) {
      return res.status(400).json({
        success: false,
        message: '缺少影片資料',
      });
    }

    console.log(`\n========== 🔍 開始關鍵字分析 ==========`);
    console.log(`[Keyword Analysis] 影片標題: ${videoData.title}`);

    // 步驟 1: 生成分析 prompt
    const prompt = generateKeywordAnalysisPrompt(videoData);

    // 步驟 2: 使用 AI 模型進行分析（使用 Gemini Flash 以節省成本）
    const modelType = 'gemini-flash-latest';
    console.log(`[Keyword Analysis] 使用模型: ${modelType}`);

    const response = await aiManager.analyze(modelType, {
      prompt,
      temperature: 0.7,
      maxTokens: 4096,
    });

    console.log('[Keyword Analysis] ✅ 分析完成');
    console.log(`[Keyword Analysis] 結果長度: ${response.text.length} 字元`);

    // 步驟 3: 解析 JSON 結果
    let analysis;
    try {
      // 嘗試從回應中提取 JSON（可能包含 markdown code block）
      const jsonMatch = response.text.match(/```json\s*([\s\S]*?)\s*```/) ||
                        response.text.match(/```\s*([\s\S]*?)\s*```/);

      const jsonText = jsonMatch ? jsonMatch[1] : response.text;
      analysis = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('[Keyword Analysis] ⚠️ JSON 解析失敗，返回原始文本');
      // 如果無法解析為 JSON，返回基本結構
      analysis = {
        currentKeywords: {
          score: 0,
          strengths: [],
          weaknesses: ['AI 分析結果格式錯誤'],
        },
        recommendedKeywords: {
          primary: [],
          secondary: [],
          longtail: [],
        },
        titleSuggestions: [],
        descriptionTips: [],
        actionPlan: {
          priority: 'medium',
          estimatedImpact: '未知',
          steps: [],
        },
        metadataHints: {
          titleHooks: [],
          descriptionAngles: [],
          callToActions: [],
        },
        rawResponse: response.text,
      };
    }

    res.json({
      success: true,
      analysis: analysis,
      metadata: {
        model: response.model,
        provider: response.provider,
        usage: response.usage,
        cost: response.cost,
      },
    });
  } catch (error) {
    console.error('[Keyword Analysis] ❌ 分析失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '關鍵字分析失敗',
    });
  }
});

/**
 * 影片搜尋字詞 API
 * POST /api/analytics/search-terms
 * 獲取單一影片的熱門搜尋字詞
 */
app.post('/api/analytics/search-terms', async (req, res) => {
  try {
    const { accessToken, channelId, videoId, daysThreshold = 365, maxResults = 10 } = req.body;

    // 驗證必要參數
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: '缺少 accessToken',
      });
    }

    if (!channelId) {
      return res.status(400).json({
        success: false,
        message: '缺少 channelId',
      });
    }

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: '缺少 videoId',
      });
    }

    console.log(`\n========== 🔍 開始獲取搜尋字詞 ==========`);
    console.log(`[Search Terms] 影片 ID: ${videoId}`);
    console.log(`[Search Terms] 天數範圍: ${daysThreshold} 天`);
    console.log(`[Search Terms] 最大結果數: ${maxResults}`);

    // 調用服務獲取搜尋字詞
    const searchTerms = await getVideoSearchTerms(
      accessToken,
      channelId,
      videoId,
      daysThreshold,
      maxResults
    );

    console.log(`[Search Terms] ✅ 找到 ${searchTerms.length} 個搜尋字詞`);

    res.json({
      success: true,
      searchTerms: searchTerms,
    });
  } catch (error) {
    console.error('[Search Terms] ❌ 獲取失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取搜尋字詞失敗',
    });
  }
});

/**
 * 外部流量細節 API
 * POST /api/analytics/external-traffic
 * 獲取單一影片的外部流量詳細資料
 */
app.post('/api/analytics/external-traffic', async (req, res) => {
  try {
    const { accessToken, channelId, videoId, daysThreshold = 365, maxResults = 25 } = req.body;

    // 驗證必要參數
    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: '缺少 accessToken',
      });
    }

    if (!channelId) {
      return res.status(400).json({
        success: false,
        message: '缺少 channelId',
      });
    }

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: '缺少 videoId',
      });
    }

    console.log(`\n========== 🌐 開始獲取外部流量細節 ==========`);
    console.log(`[External Traffic] 影片 ID: ${videoId}`);
    console.log(`[External Traffic] 天數範圍: ${daysThreshold} 天`);
    console.log(`[External Traffic] 最大結果數: ${maxResults}`);

    // 調用服務獲取外部流量細節
    const trafficDetails = await getVideoExternalTrafficDetails(
      accessToken,
      channelId,
      videoId,
      daysThreshold,
      maxResults
    );

    console.log(`[External Traffic] ✅ Google 搜尋觀看: ${trafficDetails.googleSearch}`);
    console.log(`[External Traffic] ✅ 外部來源數量: ${trafficDetails.topExternalSources.length}`);

    res.json({
      success: true,
      googleSearch: trafficDetails.googleSearch,
      adjustedExternal: trafficDetails.adjustedExternal,
      totalExternalViews: trafficDetails.totalExternalViews,
      topExternalSources: trafficDetails.topExternalSources,
    });
  } catch (error) {
    console.error('[External Traffic] ❌ 獲取失敗:', error);
    res.status(500).json({
      success: false,
      message: error.message || '獲取外部流量細節失敗',
    });
  }
});

// ==================== 影片快取 API ====================

/**
 * API: 生成並上傳影片快取到 Gist
 * POST /api/video-cache/generate
 */
app.post('/api/video-cache/generate', async (req, res) => {
  try {
    const genRate = checkRateLimit(req.user?.email || req.ip, aiRateLimiter, MAX_AI_REQUESTS_PER_HOUR);
    if (!genRate.allowed) {
      return res.status(429).json({ error: `請求過於頻繁，請於 ${genRate.waitMinutes} 分鐘後再試` });
    }

    const { accessToken, channelId, gistToken, gistId } = req.body;

    console.log('[API] ========================================');
    console.log('[API] 📦 收到生成影片快取請求');
    console.log('[API] ========================================');

    if (!accessToken) {
      console.log('[API] ❌ 缺少 accessToken');
      return res.status(400).json({ error: '缺少 accessToken' });
    }

    if (!channelId) {
      console.log('[API] ❌ 缺少 channelId');
      return res.status(400).json({ error: '缺少 channelId' });
    }

    if (!gistToken) {
      console.log('[API] ❌ 缺少 gistToken');
      return res.status(400).json({ error: '缺少 gistToken' });
    }

    console.log(`[API] 📺 頻道 ID: ${channelId}`);
    console.log(`[API] 🆔 Gist ID: ${gistId || '(首次建立)'}`);
    console.log('[API] 🚀 開始生成影片快取...\n');

    // 步驟 1: 從 YouTube 抓取所有影片標題
    const videos = await fetchAllVideoTitles(accessToken, channelId);

    console.log(`\n[API] ✅ 抓取完成，共 ${videos.length} 支影片`);

    // 步驟 2: 上傳到 Gist
    const gistInfo = await uploadToGist(videos, gistToken, gistId || null, channelId);

    console.log('\n[API] ========================================');
    console.log('[API] ✅ 影片快取生成成功！');
    console.log('[API] ========================================');
    console.log(`[API] 📊 總影片數: ${videos.length}`);
    console.log(`[API] 🆔 Gist ID: ${gistInfo.id}`);
    console.log(`[API] 🔗 Gist URL: ${gistInfo.url}`);
    console.log('[API] ========================================\n');

    res.json({
      success: true,
      totalVideos: videos.length,
      gistId: gistInfo.id,
      gistUrl: gistInfo.url,
      rawUrl: gistInfo.rawUrl,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('\n[API] ========================================');
    console.error('[API] ❌ 生成影片快取錯誤');
    console.error('[API] ========================================');
    console.error(`[API] 錯誤訊息: ${error.message}`);
    console.error('[API] ========================================\n');
    res.status(500).json({
      error: error.message || '生成影片快取失敗',
    });
  }
});

/**
 * AI 分析對話 API（SSE 串流）
 * POST /api/analytics/ai-chat
 * 接收自然語言需求，透過 tool calling 自動拉取數據並生成報告
 */
app.post('/api/analytics/ai-chat', async (req, res) => {
  const { query, model = 'gemini-flash-latest', messages = [], accessToken, channelId } = req.body;

  if (!query && messages.length === 0) {
    return res.status(400).json({ error: '缺少分析需求' });
  }
  if (!accessToken || !channelId) {
    return res.status(400).json({ error: '缺少 accessToken 或 channelId' });
  }

  const aiRate = checkRateLimit(req.user?.email || req.ip, aiRateLimiter, MAX_AI_REQUESTS_PER_HOUR);
  if (!aiRate.allowed) {
    return res.status(429).json({ error: `請求過於頻繁，請於 ${aiRate.waitMinutes} 分鐘後再試` });
  }

  const gistId = process.env.GITHUB_GIST_ID;
  const gistToken = process.env.GITHUB_GIST_TOKEN || null;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  // SSE 設定
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const toolContext = { accessToken, channelId, gistId, gistToken };

  try {
    // YouTube Analytics 資料遞延 1–3 天，用 3 天前作為可靠的 endDate
    const todayRaw = new Date();
    const today = todayRaw.toISOString().split('T')[0];
    const analyticsEnd = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const systemPrompt = `你是一位資深 YouTube 頻道數據分析師，幫頻道主從數據中找出「可行動的洞察」，而不只是複述數字。
今天是 ${today}。YouTube Analytics 資料有 1–3 天遞延，請以 ${analyticsEnd} 作為 endDate 上限，預設分析範圍是最近一年（${oneYearAgo} ~ ${analyticsEnd}）。

工具使用規則：
1. 分析整個頻道整體表現 → 用 get_channel_analytics（不需 video ID）
2. 問「哪些影片表現最好/最差」→ 直接用 get_top_videos，不要繞道 search_videos_by_keyword
3. 分析特定單元/關鍵字相關影片 → 先 search_videos_by_keyword 找影片，再 get_video_analytics 取數據
4. 完播率異常低的影片 → 用 get_retention_curve 深入分析
5. 問觀眾年齡/性別組成 → 用 get_audience_demographics；若回傳 available=false 表示人數不足門檻，如實告知
6. 工具回傳錯誤或空資料時，明確告知用戶該數據無法取得，不可用假設值填補
7. 用戶未指定日期時，預設抓「最近一年」，並盡量同時抓「前一年同期」做對照（沒有對照期就無法判斷好壞）
8. 必須等工具回傳真實數據後才能分析，絕對不可編造或假設數據。
9. 提及影片時，用 [影片標題](https://www.youtube.com/watch?v=VIDEO_ID) 格式，禁止在報告中裸露影片 ID 或用 backtick 包住 ID。

分析品質契約（每次都要做到）：
- **對照**：關鍵指標一律和前一個對等期間比較，算出絕對變化與百分比變化（例：觀看 12,345 → 18,900，+53.1%），禁止只報單一期間絕對值。
- **衍生指標**：自行推導互動率（(讚+留言+分享)/觀看×100%）、平均每支影片觀看數、搜尋流量佔比、淨訂閱等，並與頻道平均比較。
- **點名 outlier**：列出表現最好的前 2 名與最差的後 2 名（影片/單元/流量來源），說明偏離平均多少、可能原因。
- **數字佐證**：每個結論都要附具體數字，禁止只給形容詞（「表現不錯」要寫成「互動率 4.2%，高於頻道平均 2.8%」）。
- **報告結構**（文字部分用以下 Markdown 結構依序輸出）：
  ## TL;DR（3 條以內，每條一句話帶關鍵數字）
  ## 關鍵發現（每點：數據＋對照＋解讀；比較類數據用 Markdown 表格，含「變化」欄）
  ## 異常與風險
  ## 行動建議（依優先級，每項對應上面的發現）
- **建議要可執行且量化**：每個建議綁定一項具體發現、給出動作、標明預期改善的指標與量化目標（例：「把開箱影片前 15 秒改為直接展示成品，目標把開場留存從 68% 提升到 80%」），禁止空泛建議。

最終輸出格式：在上述 Markdown 文字報告之後，附上一個 JSON code block（格式如下）。文字報告本身不要包含任何 JSON 或程式碼。

\`\`\`json
{
  "charts": [
    {
      "type": "bar",
      "title": "圖表標題",
      "xKey": "videoId 或 label 欄位名稱",
      "bars": [
        { "dataKey": "views", "label": "觀看數", "color": "#FF0000" }
      ],
      "data": [{ "label": "影片標題（縮短）", "views": 12345 }]
    },
    {
      "type": "line",
      "title": "留存率曲線",
      "xKey": "elapsedVideoRatio",
      "lines": [{ "dataKey": "watchRatio", "label": "留存率", "color": "#FF0000" }],
      "data": [{ "elapsedVideoRatio": 0.1, "watchRatio": 0.85 }]
    }
  ],
  "summary": "一句話摘要",
  "recommendations": [
    { "priority": "高", "action": "具體建議", "metric": "預期改善的指標" }
  ]
}
\`\`\``;

    // 組合 messages
    const conversationMessages = [
      ...messages,
      { role: 'user', content: query || messages[messages.length - 1]?.content },
    ];

    // ─── 決定用哪個 API 做 tool calling ───
    // 根據前端選擇的 model 決定走哪個 API
    // gemini-* → Gemini API；其他（含 anthropic/、openai/ 等）→ OpenRouter
    const isGeminiModel = model.startsWith('gemini');
    const useGemini = isGeminiModel && !!geminiApiKey;
    const useOpenRouter = !isGeminiModel && !!openRouterApiKey;

    if (!useGemini && !useOpenRouter) {
      const missing = isGeminiModel ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY';
      sendEvent('error', { message: `未設定 ${missing}，無法使用此模型` });
      return res.end();
    }

    sendEvent('status', { message: '開始分析需求...' });

    let finalText = '';

    if (useGemini) {
      // ─── Gemini tool calling ───
      const { GoogleGenAI } = await import('@google/genai');
      const genai = new GoogleGenAI({ apiKey: geminiApiKey });

      const geminiModel = model;

      const tools = [{
        functionDeclarations: TOOL_DEFINITIONS.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];

      // 帶入對話歷史（user/model 交替；合併連續同 role 並確保以 user 結尾）
      let contents;
      try {
        const mapped = conversationMessages
          .filter((m) => m && typeof m.content === 'string' && m.content.trim())
          .map((m) => ({
            role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }));
        contents = [];
        for (const c of mapped) {
          const last = contents[contents.length - 1];
          if (last && last.role === c.role) last.parts.push(...c.parts);
          else contents.push(c);
        }
        if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
          contents.push({ role: 'user', parts: [{ text: query || '' }] });
        }
      } catch {
        contents = [{ role: 'user', parts: [{ text: query || '' }] }];
      }

      // Tool calling loop（最多 5 輪）
      for (let round = 0; round < 5; round++) {
        const response = await generateContentWithFallback(genai, {
          contents,
          config: {
            tools,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            temperature: 0.3,
          },
        }, { preferredModel: geminiModel, logPrefix: '[Chat]' });

        const candidate = response.candidates?.[0];
        if (!candidate) break;

        const parts = candidate.content?.parts || [];
        const toolCalls = parts.filter(p => p.functionCall);
        const textParts = parts.filter(p => p.text);

        if (toolCalls.length === 0) {
          // 沒有 tool call → 最終回應
          finalText = textParts.map(p => p.text).join('');
          break;
        }

        // 執行所有 tool calls
        contents.push({ role: 'model', parts });

        const TOOL_LABELS = {
          get_channel_analytics: '頻道整體數據',
          get_top_videos: '影片排名',
          get_video_analytics: '指定影片數據',
          get_retention_curve: '留存曲線',
          search_videos_by_keyword: '關鍵字搜尋',
          get_audience_demographics: '觀眾人口',
        };

        const collectedLabels = [];
        // 所有 tool 並行執行，縮短等待時間
        const toolResults = await Promise.all(
          toolCalls.map(async part => {
            const { name, args } = part.functionCall;
            const label = TOOL_LABELS[name] || name;
            sendEvent('status', { message: `查詢${label}...` });
            try {
              const result = await executeTool(name, args, toolContext);
              collectedLabels.push(label);
              return { functionResponse: { name, response: result } };
            } catch (toolErr) {
              return { functionResponse: { name, response: { error: toolErr.message } } };
            }
          })
        );

        // 告知使用者已收集哪些資料，避免等待生成報告時感覺沒有進展
        if (collectedLabels.length > 0) {
          const uniqueLabels = [...new Set(collectedLabels)];
          sendEvent('status', { message: `已取得：${uniqueLabels.join('、')}，生成報告中...` });
        }

        contents.push({ role: 'user', parts: toolResults });
      }

    } else {
      // ─── OpenRouter tool calling ───
      const orModel = model.includes('/') ? model : 'anthropic/claude-sonnet-4.5';

      const orMessages = [
        { role: 'system', content: systemPrompt },
        ...conversationMessages,
      ];

      // Tool calling loop（最多 5 輪）
      for (let round = 0; round < 5; round++) {
        const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openRouterApiKey}`,
            'HTTP-Referer': process.env.APP_URL || 'https://ai-video-writer.com',
            'X-Title': 'AI Video Writer',
          },
          body: JSON.stringify({
            model: orModel,
            messages: orMessages,
            tools: TOOL_DEFINITIONS,
            tool_choice: 'auto',
            temperature: 0.3,
            max_tokens: 8192,
          }),
        });

        if (!orRes.ok) {
          const err = await orRes.json();
          throw new Error(err.error?.message || `OpenRouter 錯誤: ${orRes.status}`);
        }

        const orData = await orRes.json();
        const choice = orData.choices?.[0];
        if (!choice) break;

        const toolCalls = choice.message?.tool_calls || [];

        if (toolCalls.length === 0) {
          finalText = choice.message?.content || '';
          break;
        }

        // 把 assistant 訊息加回 messages
        orMessages.push(choice.message);

        // 執行 tool calls（並行）
        const orToolMessages = await Promise.all(
          toolCalls.map(async tc => {
            const name = tc.function.name;
            const args = JSON.parse(tc.function.arguments || '{}');
            const label = TOOL_LABELS[name] || name;
            sendEvent('status', { message: `查詢${label}...` });
            try {
              const result = await executeTool(name, args, toolContext);
              return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
            } catch (toolErr) {
              return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: toolErr.message }) };
            }
          })
        );
        orMessages.push(...orToolMessages);
      }
    }

    // ─── 解析最終回應：拆分文字 + JSON charts ───
    sendEvent('status', { message: '生成報告中...' });

    let analysisText = finalText;
    let chartsData = null;

    // 容錯抽取 JSON code block（大小寫、有無 json 標記皆可）
    const fenceMatch =
      finalText.match(/```json\s*([\s\S]*?)```/i) || finalText.match(/```\s*(\{[\s\S]*?\})\s*```/);
    if (fenceMatch) {
      const raw = fenceMatch[1].trim();
      const tryParse = (s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      };
      // 先直接 parse，失敗再修正常見問題（尾逗號、智慧引號）
      chartsData =
        tryParse(raw) ||
        tryParse(raw.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
      if (!chartsData) {
        console.warn('[AI Chat] charts JSON 解析失敗，已從文字移除原始區塊');
      }
    }
    // 無論成功與否，移除任何 ```json/``` 區塊，避免原始 JSON 噴到畫面
    analysisText = finalText
      .replace(/```json[\s\S]*?```/gi, '')
      .replace(/```\s*\{[\s\S]*?\}\s*```/g, '')
      .trim();

    // 串流輸出文字（以段落為單位，避免半截 markdown 破版/閃爍）
    const blocks = analysisText.split(/\n{2,}/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      sendEvent('chunk', { text: block + '\n\n' });
      await new Promise((r) => setTimeout(r, 20));
    }

    // 圖表 + 摘要 + 建議照送（即使部分缺失也送，避免一壞全沒）
    sendEvent('charts', {
      charts: Array.isArray(chartsData?.charts) ? chartsData.charts : [],
      recommendations: Array.isArray(chartsData?.recommendations) ? chartsData.recommendations : [],
      summary: typeof chartsData?.summary === 'string' ? chartsData.summary : '',
    });

    sendEvent('done', { message: '分析完成' });

  } catch (err) {
    console.error('[AI Chat] 錯誤:', err.message);
    sendEvent('error', { message: err.message || '分析失敗' });
  } finally {
    res.end();
  }
});

/**
 * 影片快取搜尋 API
 * GET /api/video-cache/search
 * Query params: query, maxResults
 */
app.get('/api/video-cache/search', async (req, res) => {
  try {
    const { query, maxResults = 10000 } = req.query;
    const gistId = process.env.GITHUB_GIST_ID;
    const gistToken = process.env.GITHUB_GIST_TOKEN || null;

    console.log('[API] 🔍 收到快取搜尋請求');
    console.log(`[API] 🆔 Gist ID: ${gistId || '(未設定)'}`);
    console.log(`[API] 🔑 搜尋關鍵字: ${query || '(無)'}`);
    console.log(`[API] 📊 最大結果數: ${maxResults}`);

    if (!gistId) {
      console.log('[API] ❌ 缺少 GITHUB_GIST_ID 環境變數');
      return res.status(400).json({
        error: '缺少 GITHUB_GIST_ID 環境變數',
        videos: [],
      });
    }

    // 先載入完整快取以取得 channelId metadata
    const cache = await loadFromGist(gistId, gistToken);
    const cacheChannelId = cache.channelId || null;

    const videos = await searchVideosFromCache(
      gistId,
      query || '',
      parseInt(maxResults) || 10000,
      gistToken
    );

    console.log(`[API] ✅ 搜尋完成，返回 ${videos.length} 筆結果`);
    if (cacheChannelId) {
      console.log(`[API] 📺 快取頻道 ID: ${cacheChannelId}`);
    }

    res.json({
      success: true,
      query: query || '',
      totalResults: videos.length,
      channelId: cacheChannelId,
      cacheUpdatedAt: cache.updatedAt || null, // ISO（UTC），前端轉 UTC+8 顯示
      videos: videos,
    });
  } catch (error) {
    console.error('[API] ❌ 快取搜尋錯誤:', error.message);
    res.status(500).json({
      error: error.message || '搜尋影片快取失敗',
      videos: [],
    });
  }
});

// 服務前端靜態檔案（Vite build 輸出的 dist）
app.use(express.static(path.join(process.cwd(), 'dist')));

// 單頁應用程式路由 fallback（最後註冊，避免吃掉 /api/*）
app.get('*', (_req, res) => {
  const indexPath = path.join(process.cwd(), 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Build not found. Please run the build process.');
  }
});

// ==================== 啟動時清理過期檔案 ====================

/**
 * 清理指定目錄中超過保留天數的檔案
 * @param {string} directory - 要清理的目錄路徑
 * @param {number} retentionDays - 保留天數
 * @returns {Promise<{deletedCount: number, deletedSize: number}>}
 */
async function cleanupOldFiles(directory, retentionDays) {
  if (!fs.existsSync(directory)) {
    return { deletedCount: 0, deletedSize: 0 };
  }

  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000; // 轉換為毫秒
  let deletedCount = 0;
  let deletedSize = 0;

  try {
    const files = fs.readdirSync(directory);

    for (const file of files) {
      const filePath = path.join(directory, file);

      try {
        const stats = fs.statSync(filePath);

        // 只處理檔案，跳過目錄
        if (!stats.isFile()) {
          continue;
        }

        // 計算檔案年齡
        const fileAge = now - stats.mtime.getTime();

        // 如果檔案超過保留天數，則刪除
        if (fileAge > retentionMs) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          deletedCount++;
          deletedSize += fileSize;

          const ageInDays = Math.floor(fileAge / (24 * 60 * 60 * 1000));
          console.log(`  🗑️  已刪除: ${file} (${(fileSize / (1024 * 1024)).toFixed(2)} MB, ${ageInDays} 天前)`);
        }
      } catch (err) {
        console.error(`  ⚠️  無法處理檔案 ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Cleanup] 讀取目錄失敗 ${directory}:`, err.message);
  }

  return { deletedCount, deletedSize };
}

/**
 * 啟動時執行清理任務
 */
async function startupCleanup() {
  console.log('\n========== 🧹 啟動清理檢查 ==========');
  console.log(`[Cleanup] 檔案保留天數: ${FILE_RETENTION_DAYS} 天`);

  // 清理暫存影片
  console.log('[Cleanup] 檢查 temp_videos 目錄...');
  const tempResult = await cleanupOldFiles(DOWNLOAD_DIR, FILE_RETENTION_DAYS);

  // 清理截圖
  console.log('[Cleanup] 檢查 public/images 目錄...');
  const imagesResult = await cleanupOldFiles(IMAGES_DIR, FILE_RETENTION_DAYS);

  // 統計總計
  const totalDeleted = tempResult.deletedCount + imagesResult.deletedCount;
  const totalSize = (tempResult.deletedSize + imagesResult.deletedSize) / (1024 * 1024);

  if (totalDeleted > 0) {
    console.log(`[Cleanup] ✅ 清理完成: 刪除 ${totalDeleted} 個檔案，釋放 ${totalSize.toFixed(2)} MB 空間`);
  } else {
    console.log('[Cleanup] ✅ 無需清理，所有檔案都在保留期限內');
  }
  console.log('========== 清理檢查完成 ==========\n');
}

// 全域錯誤處理（必須在所有路由之後）：正式環境只回通用訊息，不外洩 stack trace
app.use(errorHandler);

// 程序層級防護：未捕捉的 rejection/exception 記錄下來，避免無聲崩潰
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  // 嚴重錯誤：記錄後讓平台重啟（Render 會自動拉起）
  process.exit(1);
});

// 啟動伺服器前先執行清理
startupCleanup().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Make sure yt-dlp is installed: https://github.com/yt-dlp/yt-dlp#installation`);
  });
}).catch((err) => {
  console.error('❌ Cleanup failed:', err);
  // 即使清理失敗也要啟動伺服器
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Make sure yt-dlp is installed: https://github.com/yt-dlp/yt-dlp#installation`);
  });
});
