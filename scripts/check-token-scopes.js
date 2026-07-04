/**
 * 檢查建快取用的 YouTube token 實際擁有哪些 OAuth scope
 * 用法：node scripts/check-token-scopes.js
 *
 * 讀取 .env.local 的 YOUTUBE_REFRESH_TOKEN（或 YOUTUBE_TOKEN / YOUTUBE_ACCESS_TOKEN），
 * 換到 access token 後打 Google tokeninfo，印出 scope 清單，
 * 並明確標示是否含 yt-analytics.readonly（方案 A 需要）。
 */

import dotenv from 'dotenv';
import { refreshAccessToken, parseTokenInput } from '../services/youtubeTokenService.js';

dotenv.config({ path: '.env.local' });

const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const ACCESS_TOKEN = process.env.YOUTUBE_TOKEN || process.env.YOUTUBE_ACCESS_TOKEN;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

async function main() {
  let accessToken;

  if (REFRESH_TOKEN) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error('❌ 有 refresh token 但缺 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET');
      process.exit(1);
    }
    console.log('🔄 用 refresh token 換 access token...');
    const data = await refreshAccessToken(REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET);
    accessToken = data.access_token;
  } else if (ACCESS_TOKEN) {
    accessToken = parseTokenInput(ACCESS_TOKEN).accessToken;
  } else {
    console.error('❌ .env.local 找不到 YOUTUBE_REFRESH_TOKEN 或 YOUTUBE_TOKEN');
    process.exit(1);
  }

  const res = await fetch(
    `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`
  );
  if (!res.ok) {
    console.error(`❌ tokeninfo 失敗: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const info = await res.json();
  const scopes = (info.scope || '').split(' ').filter(Boolean);

  console.log('\n📋 這顆 token 的 scopes：');
  scopes.forEach(s => console.log(`   - ${s}`));

  const hasAnalytics = scopes.includes(ANALYTICS_SCOPE);
  console.log('\n========================================');
  console.log(hasAnalytics
    ? '✅ 有 yt-analytics.readonly —— 方案 A 可行'
    : '❌ 沒有 yt-analytics.readonly —— 方案 A 不可行，需要重新授權（同意畫面勾選 Analytics）或改用方案 B');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('❌ 錯誤:', err.message);
  process.exit(1);
});
