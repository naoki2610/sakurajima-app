const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

// 頑健なネットワーク通信関数（3回まで自動リトライ）
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

// 複雑な気象庁XMLから降灰エリア（AshFallItem）を再帰的に探し出す関数
function findAshFallItems(obj, items = []) {
  if (!obj) return items;
  if (typeof obj === 'object') {
      for (let key in obj) {
          if (key.includes('AshFallItem')) {
              if (Array.isArray(obj[key])) items.push(...obj[key]);
              else items.push(obj[key]);
          } else {
              findAshFallItems(obj[key], items);
          }
      }
  }
  return items;
}

async function main() {
  console.log('🌐 総合防災データの収集を開始します...');

  const outDir = path.join(process.cwd(), 'public', 'data');
  const dataFile = path.join(outDir, 'dashboard_data.json');

  let existingEruptions = [];
  if (fs.existsSync(dataFile)) {
      try {
          const raw = fs.readFileSync(dataFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed.volcano && parsed.volcano.recentEruptions) {
              existingEruptions = parsed.volcano.recentEruptions;
          }
      } catch (e) {
          console.log('⚠️ 既存データの読み込みをスキップします。');
      }
  }

  let volcanoData = {
    hasAshfallWarning: false,
    ashfallGeoJson: { type: "FeatureCollection", features: [] },
    recentEruptions: existingEruptions
  };

  const jmaHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/xml, text/xml, */*; q=0.01',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  let forecastUrl = null;

  try {
    console.log('取得中: 気象庁 高頻度フィード (eqvol.xml)...');
    const response = await fetchWithRetry('https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', { headers: jmaHeaders }, 3);
    const xmlData = await response.text();
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);
    
    const entries = result.feed?.entry || [];
    for (const entry of entries) {
       // 【修正点】タイトルだけでなく、本文（content）も全て文字列として連結し、徹底的に「桜島」を検索する
       const eTitle = entry.title ? entry.title[0] : "";
       const eContent = entry.content ? JSON.stringify(entry.content) : "";
       const combinedText = eTitle + eContent;

       // 桜島に関連し、かつ火山に関する情報であるかを判定
       if (combinedText.includes('桜島') && (eTitle.includes('火山') || eTitle.includes('降灰'))) {
           const eTime = entry.updated ? entry.updated[0] : null;
           
           if (eTime) {
               const isDuplicate = volcanoData.recentEruptions.some(e => e.time === eTime && e.title === eTitle);
               if (!isDuplicate) {
                   volcanoData.recentEruptions.push({ time: eTime, title: eTitle });
               }
           }

           if (eTitle.includes('降灰予報') && !forecastUrl) {
               forecastUrl = entry.link[0].$.href;
           }
       }
    }
    
    // 過去3時間以内のデータのみを残すフィルター処理
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    volcanoData.recentEruptions = volcanoData.recentEruptions.filter(e => {
        if (e.time === '【システム警告】') return false;
        if (e.time === '不明') return false;
        const eDate = new Date(e.time);
        return eDate >= threeHoursAgo;
    });
    volcanoData.recentEruptions.sort((a, b) => new Date(b.time) - new Date(a.time));

    if (volcanoData.recentEruptions.length > 0) {
        volcanoData.hasAshfallWarning = true;
    }

  } catch (error) {
    console.error(`❌ 気象庁基本データの取得エラー: ${error.message}`);
    volcanoData.hasAshfallWarning = true;
    volcanoData.recentEruptions.unshift({
        time: "【システム警告】",
        title: "気象庁データの取得に失敗しました。過去3時間のデータが最新ではない可能性があります。"
    });
  }

  // 詳細な予測降灰エリアデータの取得とGeoJSON変換
  if (forecastUrl) {
      console.log(`詳細な降灰予報エリアデータを取得・解析します: ${forecastUrl}`);
      try {
          const detailRes = await fetchWithRetry(forecastUrl, { headers: jmaHeaders }, 3);
          const detailXml = await detailRes.text();
          const detailParser = new xml2js.Parser();
          const detailParsed = await detailParser.parseStringPromise(detailXml);

          const ashFallItems = findAshFallItems(detailParsed);
          
          ashFallItems.forEach(item => {
              let amount = "不明";
              const jsonStr = JSON.stringify(item);
              if (jsonStr.includes('多量')) amount = "多量";
              else if (jsonStr.includes('やや多量')) amount = "やや多量";
              else if (jsonStr.includes('少量')) amount = "少量";

              const posListMatch = jsonStr.match(/"gml:posList":\["([^"]+)"\]/);
              if (posListMatch && posListMatch[1] && amount !== "不明") {
                  const coordsRaw = posListMatch[1].trim().split(/\s+/);
                  let coordinates = [];
                  for (let i = 0; i < coordsRaw.length; i += 2) {
                      const lat = parseFloat(coordsRaw[i]);
                      const lon = parseFloat(coordsRaw[i + 1]);
                      if (!isNaN(lat) && !isNaN(lon)) coordinates.push([lon, lat]);
                  }
                  
                  if (coordinates.length > 2) {
                      const firstNode = coordinates[0];
                      const lastNode = coordinates[coordinates.length - 1];
                      if (firstNode[0] !== lastNode[0] || firstNode[1] !== lastNode[1]) coordinates.push(firstNode);

                      volcanoData.ashfallGeoJson.features.push({
                          type: "Feature",
                          properties: { volcano: "桜島", amount: amount },
                          geometry: { type: "Polygon", coordinates: [coordinates] }
                      });
                  }
              }
          });
          console.log(`✅ 降灰エリアのポリゴン抽出に成功しました (エリア数: ${volcanoData.ashfallGeoJson.features.length})`);
      } catch (err) {
          console.log(`⚠️ 降灰予報エリアデータの解析に失敗しましたが、処理を継続します: ${err.message}`);
      }
  }

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

    const now = new Date();
    const currentHour = now.getHours();
    let startIndex = wData.hourly.time.findIndex(t => new Date(t).getHours() === currentHour && new Date(t).getDate() === now.getDate());
    if (startIndex === -1) startIndex = 24;

    for (let i = -3; i <= 3; i++) {
      const idx = startIndex + i;
      if (idx >= 0 && idx < wData.hourly.time.length) {
        const timeObj = new Date(wData.hourly.time[idx]);
        hourlyForecast.push({
          time: `${timeObj.getHours()}:00`,
          offset: i,
          temp: Math.round(wData.hourly.temperature_2m[idx]),
          windSpeed: Math.round(wData.hourly.wind_speed_80m[idx] * 10) / 10,
          windDir: wData.hourly.wind_direction_80m[idx],
          windSpeed1000m: Math.round(wData.hourly.wind_speed_1000hPa[idx] * 10) / 10,
          windDir1000m: wData.hourly.wind_direction_1000hPa[idx],
          pressure: wData.hourly.surface_pressure[idx],
          info: getW(wData.hourly.weather_code[idx])
        });
      }
    }
  } catch (error) {
    console.log(`❌ 気象APIエラー: ${error.message}`);
  }

  if (hourlyForecast.length === 0) {
      for (let i = -3; i <= 3; i++) {
          hourlyForecast.push({
              time: '不明', offset: i, temp: 0, windSpeed: 0, windDir: 0, windSpeed1000m: 0, windDir1000m: 0, pressure: 1010, info: { icon: '⚠️', text: '取得失敗' }
          });
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
