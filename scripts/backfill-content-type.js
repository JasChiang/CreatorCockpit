/**
 * 只補 creatorContentType 到現有 Gist 快取（不重抓影片，不碰 Data API 額度）
 * 用法：node scripts/backfill-content-type.js
 *
 * 流程：
 *   1. 讀現有 Gist 快取（loadFromGist）
 *   2. 打 Analytics 拿 videoId → creatorContentType 的 map（每頁 1 單位 Analytics 額度）
 *   3. 併進每支影片，沒被涵蓋到的標 'unknown'
 *   4. 寫回同一個 Gist（uploadToGist / PATCH）
 *
 * 刻意「不」呼叫 fetchAllVideoTitles，所以不會觸發昂貴的 search.list（每頁 100 單位）。
 */

import dotenv from 'dotenv';
import {
  loadFromGist,
  uploadToGist,
  fetchCreatorContentTypeMap,
} from '../services/videoCacheService.js';
import { refreshAccessToken, parseTokenInput } from '../services/youtubeTokenService.js';

dotenv.config({ path: '.env.local' });

const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const ACCESS_TOKEN = process.env.YOUTUBE_TOKEN || process.env.YOUTUBE_ACCESS_TOKEN;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const GIST_TOKEN = process.env.GITHUB_GIST_TOKEN;
const GIST_ID = process.env.GITHUB_GIST_ID;

async function main() {
  console.log('========================================');
  console.log('🏷️  只補 creatorContentType（不重抓影片）');
  console.log('========================================\n');

  // 檢查必要環境變數
  const missing = [];
  if (!REFRESH_TOKEN && !ACCESS_TOKEN) missing.push('YOUTUBE_REFRESH_TOKEN 或 YOUTUBE_TOKEN');
  if (!CHANNEL_ID) missing.push('YOUTUBE_CHANNEL_ID');
  if (!GIST_TOKEN) missing.push('GITHUB_GIST_TOKEN');
  if (!GIST_ID) missing.push('GITHUB_GIST_ID');
  if (REFRESH_TOKEN && (!CLIENT_ID || !CLIENT_SECRET)) {
    missing.push('YOUTUBE_CLIENT_ID 和 YOUTUBE_CLIENT_SECRET（用 refresh token 時需要）');
  }
  if (missing.length) {
    console.error('❌ 缺少環境變數：');
    missing.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }

  // 取得 access token
  let accessToken;
  if (REFRESH_TOKEN) {
    console.log('🔄 用 refresh token 換 access token...');
    accessToken = (await refreshAccessToken(REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET)).access_token;
  } else {
    accessToken = parseTokenInput(ACCESS_TOKEN).accessToken;
  }

  // 1. 讀現有快取
  const cache = await loadFromGist(GIST_ID, GIST_TOKEN);
  const videos = cache.videos || [];
  console.log(`\n📥 現有快取影片數：${videos.length}`);

  // 2. 拿 creatorContentType map
  const typeMap = await fetchCreatorContentTypeMap(accessToken, CHANNEL_ID);

  // 3. 併入，沒涵蓋到的標 unknown
  const counts = {};
  for (const v of videos) {
    const type = typeMap.get(v.videoId) || 'unknown';
    v.creatorContentType = type;
    counts[type] = (counts[type] || 0) + 1;
  }

  console.log('\n📊 標記結果分布：');
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, n]) => console.log(`   - ${type}: ${n}`));

  // 4. 寫回 Gist（沿用原 channelId）
  console.log('\n📤 寫回 Gist...');
  const info = await uploadToGist(videos, GIST_TOKEN, GIST_ID, cache.channelId || CHANNEL_ID);

  console.log('\n✅ 完成！');
  console.log(`   🔗 ${info.url}`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ backfill 失敗:', err.message);
  process.exit(1);
});
