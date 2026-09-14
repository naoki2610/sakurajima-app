const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      console.log(`[警告] HTTP Error ${response.status} (試行 ${i + 1}/${retries})...`);
    } catch (err) {
      console.log(`[警告] 通信エラー (試行 ${i + 1}/${retries}): ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`通信に完全に失敗しました: ${url}`);
}

async function main() {
  console.log('🌐 総合防災データの収集を開始します...');
  const outDir = path.join(process.cwd(), 'public', 'data');
  const dataFile = path.join(outDir, 'dashboard_data.json');

  // 【決定版・絶対死守の鉄則】
  // まずローカル（同一ワークスペース内）に既存ファイルがあれば、それを最優先のベース（直近の状態）として読み込む
  let previousData = {
    hasAshfallWarning: false,
    ashfallGeoJson: { type: "FeatureCollection", features: [] },
    recentEruptions: [],
    validUntil: null,
    directionText: null
  };

  if (fs.existsSync(dataFile)) {
      try {
          const rawLocal = fs.readFileSync(dataFile, 'utf8');
          previousData = JSON.parse(rawLocal);
          console.log(`✅ ローカルファイルから既存状態を確実にロードしました（ポリゴン数: ${previousData.ashfallGeoJson?.features?.length || 0}）`);
      } catch (e) {
          console.log('⚠️ ローカルファイルのパースに失敗しました。');
      }
  }

  // 次に本番環境からも最新の状態を同期試行（失敗してもローカルのpreviousDataがあるため絶対にデータが消えない）
  try {
      const timestamp = new Date().getTime();
      const liveRes = await fetch(`https://raw.githubusercontent.com/naoki2610/sakurajima-app/gh-pages/data/dashboard_data.json?t=${timestamp}`);
      if (liveRes.ok) {
          const parsed = await liveRes.json();
          if (parsed.volcano && parsed.volcano.ashfallGeoJson?.features?.length > 0) {
              // 本番により新しいポリゴンがあればマージ、なければ既存を維持
              if (previousData.ashfallGeoJson.features.length === 0) {
                  previousData = parsed.volcano;
                  console.log('✅ 本番環境から状態を補完しました。');
              }
          }
      }
  } catch (e) {
      console.log('⚠️ 本番環境からの同期スキップ（ローカルデータを維持します）。');
  }

  let volcanoData = previousData; // 既存の状態を引き継ぐ

  const jmaHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/xml, text/xml, */*; q=0.01',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  let forecastUrls = [];
  let hasJmaError = false;

  try {
    console.log('取得中: 気象庁 高頻度フィード (eqvol.xml)...');
    const response = await fetchWithRetry('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', { headers: jmaHeaders }, 3);
    const xmlData = await response.text();
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);
    
    const entries = result.feed?.entry || [];
    for (const entry of entries) {
       const eTitle = entry.title ? entry.title[0] : "";
       const eContent = entry.content ? JSON.stringify(entry.content) : "";
       const combinedText = eTitle + eContent;

       if (combinedText.includes('桜島') && (eTitle.includes('火山') || eTitle.includes('降灰') || eTitle.includes('警報'))) {
           const eTime = entry.updated ? entry.updated[0] : null;
           if (eTime) {
               if (!volcanoData.recentEruptions.some(e => e.time === eTime)) {
                   volcanoData.recentEruptions.push({ time: eTime, title: eTitle });
               }
           }
           if (eTitle.includes('降灰予報')) {
               forecastUrls.push(entry.link[0].$.href);
           }
       }
    }
    
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    volcanoData.recentEruptions = volcanoData.recentEruptions.filter(e => {
        if (e.time === '【システム警告】' || e.time === '不明') return false;
        return new Date(e.time) >= twelveHoursAgo;
    });
    volcanoData.recentEruptions.sort((a, b) => new Date(b.time) - new Date(a.time));

  } catch (error) {
    console.error(`❌ 気象庁基本データの取得エラー: ${error.message}`);
    hasJmaError = true;
  }

  let fetchedPolygons = [];
  let fetchedValidUntil = null;
  let fetchedDirection = null;

  if (forecastUrls.length > 0 && !hasJmaError) {
      const targetUrls = [...new Set(forecastUrls)].slice(0, 2);
      
      for (const url of targetUrls) {
          try {
              const res = await fetchWithRetry(url, { headers: jmaHeaders }, 3);
              const rawXml = await res.text();
              
              if (!fetchedValidUntil) {
                  const validMatch = rawXml.match(/<[^>]*ValidDateTime>([^<]+)<\//);
                  if (validMatch) fetchedValidUntil = validMatch[1].trim();
              }

              if (!fetchedDirection) {
                  const textMatch = rawXml.match(/火口から([^<。]+方向[^<。]*)[にへ]火山灰が流され/);
                  if (textMatch) fetchedDirection = textMatch[1].trim();
                  else {
                      const pdMatch = rawXml.match(/<[^>]*PlumeDirection[^>]*description="([^"]+)"/);
                      if (pdMatch && !pdMatch[1].includes('不明')) fetchedDirection = pdMatch[1].trim();
                  }
              }

              const items = rawXml.split(/<[^>]*Item>/i);
              items.forEach(itemStr => {
                  let amount = "不明";
                  if (itemStr.includes('多量') && !itemStr.includes('やや多量')) amount = "多量";
                  else if (itemStr.includes('やや多量')) amount = "やや多量";
                  else if (itemStr.includes('少量')) amount = "少量";

                  if (amount !== "不明") {
                      const posRegex = /<[^>]*posList>([^<]+)<\//g;
                      let match;
                      while ((match = posRegex.exec(itemStr)) !== null) {
                          const raw = match[1].trim().split(/\s+/);
                          let coords = [];
                          for (let i = 0; i < raw.length; i += 2) {
                              const lat = parseFloat(raw[i]);
                              const lon = parseFloat(raw[i + 1]);
                              if (!isNaN(lat) && !isNaN(lon)) coords.push([lon, lat]);
                          }
                          if (coords.length > 2) {
                              if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
                                  coords.push(coords[0]);
                              }
                              fetchedPolygons.push({
                                  type: "Feature", properties: { volcano: "桜島", amount: amount },
                                  geometry: { type: "Polygon", coordinates: [coords] }
                              });
                          }
                      }
                  }
              });
          } catch (err) {
              console.log(`⚠️ 詳細XMLの解析エラー: ${err.message}`);
          }
      }
  }

  // 新しいデータが取得できた場合のみ更新。取得できなかった場合は既存データを保持する
  if (fetchedPolygons.length > 0) {
      volcanoData.ashfallGeoJson.features = fetchedPolygons;
  }
  if (fetchedValidUntil) volcanoData.validUntil = fetchedValidUntil;
  if (fetchedDirection) volcanoData.directionText = fetchedDirection;

  // 有効期限の厳格なチェック。期限切れのときのみクリアする
  const now = new Date();
  if (volcanoData.validUntil && now.getTime() > new Date(volcanoData.validUntil).getTime()) {
      console.log(`ℹ️ 有効期限(${volcanoData.validUntil})を過ぎたため、降灰エリアと警告をクリアします。`);
      volcanoData.ashfallGeoJson.features = [];
      volcanoData.directionText = null;
      volcanoData.validUntil = null;
  }

  let warningActive = false;
  if (volcanoData.validUntil && now <= new Date(volcanoData.validUntil)) {
      warningActive = true;
  }

  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const hasRecentEruption = volcanoData.recentEruptions.some(e => {
      if (e.time === '【システム警告】') return false;
      return new Date(e.time) >= sixHoursAgo && (e.title.includes('噴火') || e.title.includes('爆発') || e.title.includes('警報'));
  });

  volcanoData.hasAshfallWarning = hasJmaError || warningActive || hasRecentEruption || (volcanoData.directionText !== null);

  console.log('取得中: Open-Meteo 上空風データ (80m & 1000m)...');
  let hourlyForecast = [];
  try {
    const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=31.5969&longitude=130.5571&hourly=temperature_2m,surface_pressure,wind_speed_80m,wind_direction_80m,wind_speed_1000hPa,wind_direction_1000hPa,weather_code&timezone=Asia%2FTokyo&past_days=1';
    const wRes = await fetchWithRetry(weatherUrl, {}, 3);
    const wData = await wRes.json();
    const getW = (code) => {
      if (code === 0) return { icon: '☀️', text: '快晴' };
      if (code <= 3) return { icon: '⛅', text: '晴れ/曇り' };
      if (code <= 48) return { icon: '🌫️', text: '霧' };
      if (code <= 67) return { icon: '☔', text: '雨' };
      if (code <= 82) return { icon: '⛄', text: '雪' };
      return { icon: '⚡', text: '雷雨' };
    };
    const currentHour = now.getHours();
    let startIndex = wData.hourly.time.findIndex(t => new Date(t).getHours() === currentHour && new Date(t).getDate() === now.getDate());
    if (startIndex === -1) startIndex = 24;
    for (let i = -3; i <= 3; i++) {
      const idx = startIndex + i;
      if (idx >= 0 && idx < wData.hourly.time.length) {
        const timeObj = new Date(wData.hourly.time[idx]);
        hourlyForecast.push({
          time: `${timeObj.getHours()}:00`, offset: i, temp: Math.round(wData.hourly.temperature_2m[idx]),
          windSpeed: Math.round(wData.hourly.wind_speed_80m[idx] * 10) / 10, windDir: wData.hourly.wind_direction_80m[idx],
          windSpeed1000m: Math.round(wData.hourly.wind_speed_1000hPa[idx] * 10) / 10, windDir1000m: wData.hourly.wind_direction_1000hPa[idx],
          pressure: wData.hourly.surface_pressure[idx], info: getW(wData.hourly.weather_code[idx])
        });
      }
    }
  } catch (error) {
    console.log(`❌ 気象APIエラー: ${error.message}`);
  }
  if (hourlyForecast.length === 0) {
      for (let i = -3; i <= 3; i++) {
          hourlyForecast.push({ time: '不明', offset: i, temp: 0, windSpeed: 0, windDir: 0, windSpeed1000m: 0, windDir1000m: 0, pressure: 1010, info: { icon: '⚠️', text: '取得失敗' } });
      }
  }

  const finalData = {
    volcano: volcanoData,
    weather: { current: { temp: 0, humidity: 0, info: { icon: '', text: '' } }, daily: [] },
    hourlyForecast: hourlyForecast
  };
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(finalData, null, 2));
  console.log('✅ データ更新が完了しました。');
}
main();
