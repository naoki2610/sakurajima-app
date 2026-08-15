const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const DATA_DIR = path.join(__dirname, '../public/data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function parseJmaCoordinates(coordStr) {
  const parts = coordStr.trim().split(/\s*\/\s*|\s+/);
  const coords = [];
  for (const part of parts) {
    if (!part) continue;
    const match = part.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    if (match) coords.push([parseFloat(match[2]), parseFloat(match[1])]);
  }
  if (coords.length > 0) {
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
  }
  return coords;
}

// Open-Meteoの天気コードをアイコンと文字に変換する簡易関数
function getWeatherInfo(code) {
  if (code === 0) return { icon: '☀️', text: '快晴' };
  if (code === 1 || code === 2 || code === 3) return { icon: '⛅', text: '晴れ/曇り' };
  if (code >= 45 && code <= 48) return { icon: '🌫️', text: '霧' };
  if (code >= 51 && code <= 67) return { icon: '☔', text: '雨' };
  if (code >= 71 && code <= 82) return { icon: '⛄', text: '雪' };
  if (code >= 95) return { icon: '⚡', text: '雷雨' };
  return { icon: '☁️', text: '不明' };
}

async function run() {
  console.log('🌐 総合防災データの収集を開始します...');
  
  // 最終的にフロントエンド（React）に渡すための大きなデータ箱
  const dashboardData = {
    volcano: {
      hasAshfallWarning: false,
      ashfallGeoJson: { type: "FeatureCollection", features: [] },
      recentEruptions: [] // 過去1時間の噴火履歴を入れる箱
    },
    weather: {
      current: null,
      daily: []
    }
  };

  const parser = new xml2js.Parser({ explicitArray: false });

  try {
    // ==========================================
    // 1. 気象庁データ（降灰予報 ＆ 噴火履歴）の取得
    // ==========================================
    console.log('取得中: 気象庁 高頻度フィード (eqvol.xml)...');
    const feedUrl = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';
    const feedRes = await fetch(feedUrl);
    if (!feedRes.ok) throw new Error(`JMA HTTP Error: ${feedRes.status}`);
    const feedXml = await feedRes.text();
    const feedData = await parser.parseStringPromise(feedXml);
    
    const entries = feedData.feed.entry || [];
    const entryArray = Array.isArray(entries) ? entries : [entries];
    
    let ashfallUrl = null;
    
    // 現在時刻から1時間前（60分）の時刻を計算
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    for (const entry of entryArray) {
      // (A) 降灰予報のURLを探す（最新の1件のみ）
      if (!ashfallUrl && entry.title.includes('降灰予報') && entry.content._.includes('桜島')) {
        ashfallUrl = entry.link.$.href;
      }

      // (B) 過去1時間以内の「噴火に関する火山観測報」を探す
      if (entry.title.includes('噴火に関する火山観測報') && entry.content._.includes('桜島')) {
        const entryDate = new Date(entry.updated);
        if (entryDate >= oneHourAgo) {
          dashboardData.volcano.recentEruptions.push({
            time: entryDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
            title: entry.title
          });
        }
      }
    }

    // 降灰予報のポリゴン化処理
    if (ashfallUrl) {
      console.log(`取得中: 桜島 降灰予報詳細 (${ashfallUrl})...`);
      const xmlRes = await fetch(ashfallUrl);
      const xmlString = await xmlRes.text();
      const parsedData = await parser.parseStringPromise(xmlString);
      
      const items = parsedData.Report?.Body?.VolcanoInfo?.Item;
      if (items) {
        dashboardData.volcano.hasAshfallWarning = true;
        const itemArray = Array.isArray(items) ? items : [items];
        for (const item of itemArray) {
          if (!item.Area || !item.Area.Coordinate) continue;
          
          let amountLevel = "少量";
          if (item.Kind?.Name) {
             if (item.Kind.Name.includes("多量")) amountLevel = "多量";
             else if (item.Kind.Name.includes("やや多量")) amountLevel = "やや多量";
          }
          dashboardData.volcano.ashfallGeoJson.features.push({
            type: "Feature",
            properties: { volcano: item.VolcanoName || '桜島', amount: amountLevel },
            geometry: { type: "Polygon", coordinates: [parseJmaCoordinates(item.Area.Coordinate)] }
          });
        }
      }
    } else {
      console.log('ℹ️ 現在、桜島の降灰予報（ポリゴン）は発表されていません。');
    }

    // ==========================================
    // 2. Open-Meteo API（天気・気温）の取得
    // ==========================================
    console.log('取得中: 鹿児島市の気象データ (Open-Meteo)...');
    // 鹿児島市の緯度経度(31.5969, 130.5571)で、現在天気と1週間の予報を取得
    const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=31.5969&longitude=130.5571&current=temperature_2m,relative_humidity_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTokyo';
    const weatherRes = await fetch(weatherUrl);
    if (!weatherRes.ok) throw new Error(`Weather API Error: ${weatherRes.status}`);
    const weatherJson = await weatherRes.json();

    // 現在の天気を整形
    const currWeatherCode = weatherJson.current.weather_code;
    dashboardData.weather.current = {
      temp: weatherJson.current.temperature_2m,
      humidity: weatherJson.current.relative_humidity_2m,
      info: getWeatherInfo(currWeatherCode)
    };

    // 週間天気を整形（直近4日分）
    for (let i = 0; i < 4; i++) {
      const dateStr = weatherJson.daily.time[i];
      const dateObj = new Date(dateStr);
      const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][dateObj.getDay()];
      const formattedDate = `${dateObj.getMonth() + 1}/${dateObj.getDate()} (${dayOfWeek})`;
      
      dashboardData.weather.daily.push({
        date: formattedDate,
        info: getWeatherInfo(weatherJson.daily.weather_code[i]),
        maxTemp: weatherJson.daily.temperature_2m_max[i],
        minTemp: weatherJson.daily.temperature_2m_min[i]
      });
    }

    // ==========================================
    // 3. 全データを1つのJSONファイルに保存
    // ==========================================
    const outputPath = path.join(DATA_DIR, 'dashboard_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(dashboardData, null, 2));
    console.log(`✅ 完了: 総合データを保存しました -> ${outputPath}`);

  } catch (error) {
    console.error('❌ データ取得中にエラーが発生しました:', error.message);
    process.exit(1);
  }
}

run();