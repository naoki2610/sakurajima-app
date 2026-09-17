const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch (err) { }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`通信失敗: ${url}`);
}

async function main() {
  console.log('🌐 防災データの収集を開始します...');
  const outDir = path.join(process.cwd(), 'public', 'data');
  const dataFile = path.join(outDir, 'dashboard_data.json');

  let previousData = {
    hasAshfallWarning: false,
    ashfallGeoJson: { type: "FeatureCollection", features: [] },
    recentEruptions: [],
    validUntil: null,
    directionText: null
  };

  if (fs.existsSync(dataFile)) {
      try { previousData = JSON.parse(fs.readFileSync(dataFile, 'utf8')).volcano || previousData; } catch (e) { }
  }
  try {
      const liveRes = await fetch(`https://raw.githubusercontent.com/naoki2610/sakurajima-app/gh-pages/data/dashboard_data.json?t=${new Date().getTime()}`);
      if (liveRes.ok) {
          const parsed = await liveRes.json();
          if (parsed.volcano) previousData = parsed.volcano;
      }
  } catch (e) { }

  let volcanoData = previousData; 
  let forecastUrls = [];
  let hasJmaError = false;

  const jmaHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/xml' };

  try {
    let allEntries = [];
    const feeds = [
        'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', // 短期（速報）フィード
        'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml' // 長期（履歴）フィード
    ];

    let successCount = 0;
    for (const feedUrl of feeds) {
        try {
            const xmlData = await (await fetchWithRetry(feedUrl, { headers: jmaHeaders }, 3)).text();
            const result = await new xml2js.Parser().parseStringPromise(xmlData);
            if (result.feed && result.feed.entry) {
                allEntries = allEntries.concat(result.feed.entry);
                successCount++;
            }
        } catch(e) {
            console.log(`フィード取得エラー: ${feedUrl}`);
        }
    }
    
    // 【エラー隠蔽の排除】両方のフィードが取れなかった場合は、明確にシステムエラーとして扱う
    if (successCount === 0) {
        throw new Error("気象庁フィードの取得に完全に失敗しました");
    }

    const uniqueEntries = Array.from(new Map(allEntries.map(e => [e.id ? e.id[0] : Math.random(), e])).values());

    for (const entry of uniqueEntries) {
       // 【ハルシネーション根絶】タイトル等の条件で絞り込まず、エントリ全体の中に「桜島」の文字があれば絶対に拾う
       const entryStr = JSON.stringify(entry);
       if (entryStr.includes('桜島')) {
           const eTitle = entry.title ? entry.title[0] : "火山情報";
           const eTime = entry.updated ? entry.updated[0] : null;
           
           if (eTime && !volcanoData.recentEruptions.some(e => e.time === eTime)) {
               volcanoData.recentEruptions.push({ time: eTime, title: eTitle });
           }
           
           // 降灰予報のURLを抽出
           if (eTitle.includes('降灰') && entry.link && entry.link[0] && entry.link[0].$) {
               forecastUrls.push(entry.link[0].$.href);
           }
       }
    }
    
    // 確実な過去12時間のフィルタリング
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    volcanoData.recentEruptions = volcanoData.recentEruptions.filter(e => {
        if (e.time === '【システム警告】' || e.time === '不明') return false;
        const d = new Date(e.time);
        return !isNaN(d.getTime()) && d >= twelveHoursAgo;
    });
    volcanoData.recentEruptions.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  } catch (error) { 
      console.error(error);
      hasJmaError = true; 
  }

  let fetchedPolygons = [];
  let fetchedValidUntil = null;
  let fetchedDirection = null;

  if (forecastUrls.length > 0 && !hasJmaError) {
      const targetUrls = [...new Set(forecastUrls)].slice(0, 3); 
      for (const url of targetUrls) {
          try {
              const rawXml = await (await fetchWithRetry(url, { headers: jmaHeaders }, 3)).text();
              
              if (!fetchedValidUntil) {
                  const validMatch = rawXml.match(/<[^>]*ValidDateTime>([^<]+)<\//);
                  if (validMatch) fetchedValidUntil = validMatch[1].trim();
              }
              
              if (!fetchedDirection) {
                  // 正規表現を強化し、気象庁の様々なテキスト揺れから確実に方向を引っこ抜く
                  const textMatch = rawXml.match(/火口から([^<。]+方向[^<。]*)[にへ]火山灰が/);
                  if (textMatch) {
                      fetchedDirection = textMatch[1].trim();
                  } else {
                      const pdMatch = rawXml.match(/<[^>]*PlumeDirection[^>]*description="([^"]+)"/);
                      if (pdMatch && !pdMatch[1].includes('不明')) {
                          fetchedDirection = pdMatch[1].trim();
                      }
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
                                  coords.push([...coords[0]]);
                              }
                              fetchedPolygons.push({ type: "Feature", properties: { volcano: "桜島", amount: amount }, geometry: { type: "Polygon", coordinates: [coords] } });
                          }
                      }
                  }
              });
          } catch (err) { console.error(`XML解析エラー: ${url}`, err); }
      }
  }

  if (fetchedPolygons.length > 0) volcanoData.ashfallGeoJson.features = fetchedPolygons;
  if (fetchedValidUntil) volcanoData.validUntil = fetchedValidUntil;
  if (fetchedDirection) volcanoData.directionText = fetchedDirection;

  const now = new Date();
  
  // 有効期限切れの厳格な判定
  if (volcanoData.validUntil) {
      const validTime = new Date(volcanoData.validUntil).getTime();
      if (!isNaN(validTime) && now.getTime() > validTime) {
          volcanoData.ashfallGeoJson.features = [];
          volcanoData.directionText = null;
          volcanoData.validUntil = null;
      }
  }

  let warningActive = volcanoData.validUntil && now.getTime() <= new Date(volcanoData.validUntil).getTime();
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const hasRecentEruption = volcanoData.recentEruptions.some(e => {
      const d = new Date(e.time);
      return !isNaN(d.getTime()) && d >= sixHoursAgo && (e.title.includes('噴火') || e.title.includes('爆発') || e.title.includes('降灰') || e.title.includes('警報'));
  });
  
  // 【フェイルセーフ】エラー発生時、または直近の噴火がある場合は警告状態を死守する
  volcanoData.hasAshfallWarning = hasJmaError || warningActive || hasRecentEruption || (volcanoData.directionText !== null);

  let hourlyForecast = [];
  try {
    const wData = await (await fetchWithRetry('https://api.open-meteo.com/v1/forecast?latitude=31.5969&longitude=130.5571&hourly=temperature_2m,surface_pressure,wind_speed_80m,wind_direction_80m,wind_speed_1000hPa,wind_direction_1000hPa,weather_code&timezone=Asia%2FTokyo&past_days=1', {}, 3)).json();
    
    // 雪バグの裏側サニタイズ
    const getW = (code, temp) => {
      let isSnow = ((code >= 71 && code <= 77) || (code >= 85 && code <= 86));
      if (isSnow && temp >= 10) return { icon: '☔', text: '雨(雹/霰)' };
      if (code === 0) return { icon: '☀️', text: '快晴' };
      if (code <= 3) return { icon: '⛅', text: '晴れ/曇り' };
      if (code <= 48) return { icon: '🌫️', text: '霧' };
      if (code <= 67) return { icon: '☔', text: '雨' };
      if (isSnow) return { icon: '⛄', text: '雪' };
      if (code <= 82) return { icon: '☔', text: 'にわか雨' };
      return { icon: '⚡', text: '雷雨' };
    };

    const jstNow = new Date(Date.now() + 9 * 3600000);
    const todayStr = jstNow.getUTCFullYear() + "-" + String(jstNow.getUTCMonth() + 1).padStart(2, '0') + "-" + String(jstNow.getUTCDate()).padStart(2, '0');
    const hourStr = String(jstNow.getUTCHours()).padStart(2, '0');
    const targetTimeStr = `${todayStr}T${hourStr}:00`;
    
    let startIndex = wData.hourly.time.findIndex(t => t === targetTimeStr);
    if (startIndex === -1) startIndex = 24;

    for (let i = -3; i <= 3; i++) {
      const idx = startIndex + i;
      if (idx >= 0 && idx < wData.hourly.time.length) {
        const timeObj = new Date(wData.hourly.time[idx]);
        const tTemp = Math.round(wData.hourly.temperature_2m[idx]);
        hourlyForecast.push({
          time: `${timeObj.getHours()}:00`, offset: i, temp: tTemp,
          windSpeed: Math.round(wData.hourly.wind_speed_80m[idx] * 10) / 10, windDir: wData.hourly.wind_direction_80m[idx],
          windSpeed1000m: Math.round(wData.hourly.wind_speed_1000hPa[idx] * 10) / 10, windDir1000m: wData.hourly.wind_direction_1000hPa[idx],
          pressure: wData.hourly.surface_pressure[idx], info: getW(wData.hourly.weather_code[idx], tTemp)
        });
      }
    }
  } catch (error) { }
  
  if (hourlyForecast.length === 0) {
      for (let i = -3; i <= 3; i++) hourlyForecast.push({ time: '不明', offset: i, temp: 0, windSpeed: 0, windDir: 0, windSpeed1000m: 0, windDir1000m: 0, pressure: 1010, info: { icon: '⚠️', text: '取得失敗' } });
  }

  const finalData = { volcano: volcanoData, weather: { current: { temp: 0, humidity: 0, info: { icon: '', text: '' } }, daily: [] }, hourlyForecast: hourlyForecast };
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(finalData, null, 2));
  console.log('✅ データ更新が完了しました。');
}
main();
