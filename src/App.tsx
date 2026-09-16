import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

function formatJST(timeStr: string) {
  if (timeStr === '【システム警告】' || timeStr === '不明') return timeStr;
  try {
    const d = new Date(timeStr);
    if (isNaN(d.getTime())) return timeStr;
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  } catch (e) {
    return timeStr;
  }
}

// 【100%修正】WMO気象コードの厳密な翻訳（80〜82のにわか雨を雪と誤認するバグを根絶）
function getWeatherInfo(code: number) {
  if (code === 0) return { icon: '☀️', text: '快晴' };
  if (code === 1 || code === 2 || code === 3) return { icon: '⛅', text: '晴れ/曇り' };
  if (code >= 45 && code <= 48) return { icon: '🌫️', text: '霧' };
  if (code >= 51 && code <= 67) return { icon: '☔', text: '雨' };
  if (code >= 71 && code <= 77) return { icon: '⛄', text: '雪' };
  if (code >= 80 && code <= 82) return { icon: '☔', text: 'にわか雨' }; // 修正箇所
  if (code >= 85 && code <= 86) return { icon: '⛄', text: '雪' };
  if (code >= 95) return { icon: '⚡', text: '雷雨' };
  return { icon: '☁️', text: '不明' };
}

// 【100%修正】「鹿屋市輝北方向」等の括弧内の文字（北など）による誤検知を防止するロジック
function getFallbackWedgeGeoJson(directionText: string) {
  // 括弧より前の「主方向」だけを抽出する（例: "東（鹿屋市..." -> "東"）
  const mainDir = directionText.split(/[（(]/)[0];
  const dirs = [
    { k: '北北東', v: 22.5 }, { k: '東北東', v: 67.5 }, { k: '東南東', v: 112.5 }, { k: '南南東', v: 157.5 },
    { k: '南南西', v: 202.5 }, { k: '西南西', v: 247.5 }, { k: '西北西', v: 292.5 }, { k: '北北西', v: 337.5 },
    { k: '北東', v: 45 }, { k: '南東', v: 135 }, { k: '南西', v: 225 }, { k: '北西', v: 315 },
    { k: '北', v: 0 }, { k: '東', v: 90 }, { k: '南', v: 180 }, { k: '西', v: 270 }
  ];
  
  let angle = null;
  for (const d of dirs) {
    if (mainDir.includes(d.k)) { angle = d.v; break; }
  }
  if (angle === null) return null;

  const center = [130.657, 31.580]; 
  const radiusKm = 50; 
  const coords = [center];
  const latPerKm = 1 / 111.32;
  const lonPerKm = 1 / (111.32 * Math.cos(center[1] * Math.PI / 180));

  const spread = 25; 
  for (let i = angle - spread; i <= angle + spread; i += 5) {
    const rad = i * Math.PI / 180;
    const dLat = radiusKm * Math.cos(rad) * latPerKm;
    const dLon = radiusKm * Math.sin(rad) * lonPerKm;
    coords.push([center[0] + dLon, center[1] + dLat]);
  }
  coords.push(center); 

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { isFallback: true },
      geometry: { type: 'Polygon', coordinates: [coords] }
    }]
  };
}

type DashboardData = {
  volcano: {
    hasAshfallWarning: boolean;
    ashfallGeoJson: { type: string; features: any[] };
    recentEruptions: { time: string; title: string }[];
    validUntil?: string | null;
    directionText?: string | null;
  };
  weather: {
    current: { temp: number; humidity: number; info: { icon: string; text: string }; };
    daily: { date: string; info: { icon: string; text: string }; maxTemp: number; minTemp: number; }[];
    localHourly?: { time: string; temp: number; pop: number; info: { icon: string; text: string }; }[];
  };
  hourlyForecast?: {
    time: string; offset: number; temp: number; windSpeed: number; windDir: number;
    windSpeed1000m: number; windDir1000m: number; pressure: number; info: { icon: string; text: string };
  }[];
};

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  
  const [activeTab, setActiveTab] = useState('menu1');
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [timeIndex, setTimeIndex] = useState<number>(3);

  useEffect(() => {
    if (!mapContainer.current) return;
    if (map.current) return; 

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
          },
        },
        layers: [{ id: 'osm-layer', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 19 }],
      },
      center: [130.657, 31.580],
      zoom: 9.5,
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.current.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true
    }), 'top-right');

    map.current.on('load', async () => {
      if (!map.current) return;
      
      const timestamp = new Date().getTime();
      try {
        const response = await fetch(`./data/dashboard_data.json?t=${timestamp}`);
        const data = await response.json();
        
        // 最初のJSONデータを即座に画面に反映させる
        setDashboardData(data); 

        // 【100%修正】天気を取得し、既存のデータに安全にマージする独立した関数
        const fetchAndMergeWeather = async (lat: number, lon: number) => {
            try {
                const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&hourly=temperature_2m,weather_code,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTokyo`);
                const weatherData = await weatherRes.json();
                
                const dailyForecasts: any[] = [];
                for (let i = 0; i < 4; i++) {
                  const dateStr = weatherData.daily.time[i];
                  const dateObj = new Date(dateStr);
                  const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][dateObj.getDay()];
                  dailyForecasts.push({
                    date: `${dateObj.getMonth() + 1}/${dateObj.getDate()} (${dayOfWeek})`,
                    info: getWeatherInfo(weatherData.daily.weather_code[i]),
                    maxTemp: Math.round(weatherData.daily.temperature_2m_max[i]), 
                    minTemp: Math.round(weatherData.daily.temperature_2m_min[i])
                  });
                }

                const nowTime = new Date().getTime();
                const startIndex = weatherData.hourly.time.findIndex((t: string) => new Date(t).getTime() > nowTime - 3600000);
                const localHourlyData = [];
                if (startIndex !== -1) {
                  for (let i = 0; i < 12; i++) {
                    const idx = startIndex + i;
                    if (idx < weatherData.hourly.time.length) {
                      const d = new Date(weatherData.hourly.time[idx]);
                      localHourlyData.push({
                        time: `${d.getHours()}:00`,
                        temp: Math.round(weatherData.hourly.temperature_2m[idx]),
                        pop: weatherData.hourly.precipitation_probability[idx] || 0,
                        info: getWeatherInfo(weatherData.hourly.weather_code[idx])
                      });
                    }
                  }
                }

                setDashboardData(prev => prev ? {
                  ...prev,
                  weather: {
                    current: {
                      temp: Math.round(weatherData.current.temperature_2m * 10) / 10,
                      humidity: weatherData.current.relative_humidity_2m,
                      info: getWeatherInfo(weatherData.current.weather_code)
                    },
                    daily: dailyForecasts,
                    localHourly: localHourlyData
                  }
                } : null);
            } catch (e) {
                console.error("天気APIの取得エラー:", e);
            }
        };

        // 【100%修正】GPS取得に失敗・タイムアウトした場合は、現在地である「日置市」の座標で確実に天気をフォールバック取得する
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
               fetchAndMergeWeather(position.coords.latitude, position.coords.longitude);
            }, 
            (error) => {
               console.warn("位置情報が拒否・失敗したため、日置市の天気を取得します。", error);
               fetchAndMergeWeather(31.628, 130.396); // 日置市の代表座標
            },
            { timeout: 5000 } // 5秒でタイムアウトさせ、画面が真っ白になるのを防ぐ
          );
        } else {
          fetchAndMergeWeather(31.628, 130.396);
        }

        // 地図レイヤーの描画（扇形フォールバック）
        let mapGeoJson = data.volcano.ashfallGeoJson;
        let isFallbackWedge = false;
        
        if ((!mapGeoJson || mapGeoJson.features.length === 0) && data.volcano.directionText) {
            const wedgeGeoJson = getFallbackWedgeGeoJson(data.volcano.directionText);
            if (wedgeGeoJson) {
                mapGeoJson = wedgeGeoJson;
                isFallbackWedge = true;
            }
        }

        if (mapGeoJson && mapGeoJson.features.length > 0) {
            map.current.addSource('ashfall-data', { type: 'geojson', data: mapGeoJson });
            
            if (isFallbackWedge) {
                map.current.addLayer({
                  id: 'ashfall-wedge-fill', type: 'fill', source: 'ashfall-data',
                  paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.35 }
                });
                map.current.addLayer({
                  id: 'ashfall-wedge-line', type: 'line', source: 'ashfall-data',
                  paint: { 'line-color': '#991b1b', 'line-width': 2, 'line-dasharray': [4, 4] }
                });
            } else {
                map.current.addLayer({
                  id: 'ashfall-fill', type: 'fill', source: 'ashfall-data',
                  paint: { 'fill-color': ['match', ['get', 'amount'], '多量', '#e11d48', 'やや多量', '#f97316', '少量', '#eab308', '#8d99ae'], 'fill-opacity': 0.55 },
                });
                map.current.addLayer({
                  id: 'ashfall-line', type: 'line', source: 'ashfall-data',
                  paint: { 'line-color': '#475569', 'line-width': 1 }
                });
            }
        }
      } catch (err) {
        console.error("初期データの読み込みに失敗しました:", err);
      }
    });

    return () => {
      if (map.current) { map.current.remove(); map.current = null; }
    };
  }, []);

  const getLifeAdvice = () => {
    if (!dashboardData) return { laundry: 'データなし', car: 'データなし', color: '#64748b' };
    const { hasAshfallWarning } = dashboardData.volcano;
    const isRaining = dashboardData.weather.current.info.text.includes('雨');
    
    if (hasAshfallWarning) return { laundry: '部屋干し推奨（降灰警戒）', car: '控えるべき（降灰警戒）', color: '#e11d48' };
    if (isRaining) return { laundry: '部屋干し推奨（雨）', car: '控えるべき（雨）', color: '#3b82f6' };
    return { laundry: '外干しOK', car: '洗車日和', color: '#16a34a' };
  };

  const getHeatstrokeAlert = (temp: number) => {
    if (temp >= 35) return { text: '危険（運動は原則中止）', color: '#9f1239', bg: '#ffe4e6' };
    if (temp >= 31) return { text: '厳重警戒（激しい運動は中止）', color: '#be123c', bg: '#fff1f2' };
    if (temp >= 28) return { text: '警戒（積極的に休息を）', color: '#c2410c', bg: '#fff7ed' };
    if (temp >= 25) return { text: '注意（こまめな水分補給）', color: '#b45309', bg: '#fef3c7' };
    return { text: 'ほぼ安全', color: '#0f766e', bg: '#f0fdf4' };
  };

  const fallbackHourly = Array.from({ length: 7 }).map((_, i) => ({
    time: `12:00`, offset: i - 3, temp: 25, windSpeed: 3.5, windDir: 180 + i * 30, windSpeed1000m: 5.0, windDir1000m: 190 + i * 30, pressure: 1010, info: { icon: '🌤️', text: '晴れ' }
  }));

  const hourlyData = dashboardData?.hourlyForecast || fallbackHourly;
  const currentSlideData = hourlyData[timeIndex];
  const prevPressure = timeIndex > 0 ? hourlyData[timeIndex - 1].pressure : currentSlideData.pressure;
  const pressureDiff = currentSlideData.pressure - prevPressure;
  let trendMsg = { text: "気圧安定", color: '#10b981' };
  if (pressureDiff <= -1.0) trendMsg = { text: "気圧低下中（突風注意）", color: '#ef4444' };
  if (pressureDiff >= 1.0) trendMsg = { text: "気圧上昇中", color: '#3b82f6' };

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, position: 'absolute', top: 0, left: 0 }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%', position: 'absolute', zIndex: 0 }} />
      
      <div style={{
        position: 'absolute', top: '20px', left: '20px', zIndex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '15px 20px',
        borderRadius: '12px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
        fontFamily: '"Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
        width: '330px', maxHeight: '90vh', overflowY: 'auto'
      }}>
        <h1 style={{ margin: '0 0 15px 0', fontSize: '18px', color: '#1e293b', borderBottom: '2px solid #e2e8f0', paddingBottom: '10px' }}>
          🌋 桜島 生活・防災モニター
        </h1>

        <div style={{ display: 'flex', gap: '4px', marginBottom: '15px' }}>
          {['menu1', 'menu2', 'menu3', 'menu4'].map((menu, idx) => {
            const labels = ['①降灰', '②現在', '③週間', '④風推移'];
            return (
              <button key={menu} onClick={() => setActiveTab(menu)} 
                style={{ flex: 1, padding: '8px 2px', fontSize: '11px', cursor: 'pointer', borderRadius: '6px', border: 'none', fontWeight: 'bold', 
                backgroundColor: activeTab === menu ? '#3b82f6' : '#f1f5f9', color: activeTab === menu ? '#fff' : '#475569' }}>
                {labels[idx]}
              </button>
            );
          })}
        </div>

        {!dashboardData ? (
          <div style={{ minHeight: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>最新データを取得中...</div>
        ) : (
          <div style={{ minHeight: '200px' }}>
            
            {activeTab === 'menu1' && (
              <div>
                {dashboardData.volcano.directionText && (
                  <div style={{ marginBottom: '12px', backgroundColor: '#fef2f2', padding: '12px', borderRadius: '8px', border: '2px solid #dc2626', boxShadow: '0 2px 4px rgba(220, 38, 38, 0.2)' }}>
                    <div style={{ fontWeight: 'bold', color: '#b91c1c', fontSize: '15px', marginBottom: '4px' }}>
                      ⚠️ 降灰警戒方向: {dashboardData.volcano.directionText}
                    </div>
                    <div style={{ fontSize: '11px', color: '#991b1b', lineHeight: '1.4' }}>
                       ※地図上の半透明の扇形は目安です。この方向では屋外作業、UAVフライト、洗濯・洗車などの生活判断に十分警戒してください。
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: '12px', backgroundColor: '#f8fafc', padding: '10px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '14px', marginBottom: '6px', color: '#334155' }}>👕 <b>洗濯予想:</b> <span style={{ color: getLifeAdvice().color }}>{getLifeAdvice().laundry}</span></div>
                  <div style={{ fontSize: '14px', color: '#334155' }}>🚗 <b>洗車予想:</b> <span style={{ color: getLifeAdvice().color }}>{getLifeAdvice().car}</span></div>
                </div>
                
                <div style={{ marginBottom: '12px', backgroundColor: '#fff7ed', padding: '10px', borderRadius: '8px', border: '1px solid #ffedd5' }}>
                  <p style={{ margin: '0 0 6px 0', fontWeight: 'bold', fontSize: '13px', color: '#c2410c' }}>🌋 過去12時間の噴火履歴</p>
                  <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#431407', lineHeight: '1.5', maxHeight: '100px', overflowY: 'auto' }}>
                    {dashboardData.volcano.recentEruptions.length === 0 ? (
                      <li>直近の噴火は観測されていません</li>
                    ) : (
                      dashboardData.volcano.recentEruptions.map((eruption, idx) => (
                        <li key={idx} style={{ marginBottom: '6px', borderBottom: '1px dashed #fed7aa', paddingBottom: '4px' }}>
                          <div style={{ fontWeight: 'bold', color: '#9a3412', fontSize: '13px' }}>{formatJST(eruption.time)}</div>
                          <div>{eruption.title}</div>
                        </li>
                      ))
                    )}
                  </ul>
                </div>
                
                <div style={{ fontSize: '14px', color: '#334155' }}>
                  <p style={{ margin: '0 0 6px 0', fontWeight: 'bold' }}>🕒 降灰予測エリア</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#e11d48', opacity: 0.6, marginRight: '4px', border: '1px solid #475569' }}></span><span style={{ fontSize: '11px' }}>多量</span></div>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#f97316', opacity: 0.6, marginRight: '4px', border: '1px solid #475569' }}></span><span style={{ fontSize: '11px' }}>やや多量</span></div>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#eab308', opacity: 0.6, marginRight: '4px', border: '1px solid #475569' }}></span><span style={{ fontSize: '11px' }}>少量</span></div>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#dc2626', opacity: 0.25, marginRight: '4px', border: '1px dashed #991b1b' }}></span><span style={{ fontSize: '11px' }}>速報目安</span></div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'menu2' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '15px', backgroundColor: '#f0f9ff', padding: '15px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '32px' }}>{dashboardData.weather.current.info.icon}</div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#0f172a' }}>{dashboardData.weather.current.temp}<span style={{ fontSize: '14px' }}>℃</span></div>
                    <div style={{ fontSize: '14px', color: '#64748b' }}>湿度: {dashboardData.weather.current.humidity}%</div>
                  </div>
                </div>
                {(() => {
                  const alert = getHeatstrokeAlert(dashboardData.weather.current.temp);
                  return (
                    <div style={{ backgroundColor: alert.bg, padding: '10px', borderRadius: '8px', border: `1px solid ${alert.color}40`, marginBottom: '15px' }}>
                      <div style={{ fontSize: '14px', color: alert.color, fontWeight: 'bold' }}>⚠️ 熱中症: {alert.text.split('（')[0]}</div>
                      <div style={{ fontSize: '12px', color: alert.color, marginTop: '4px' }}>（{alert.text.split('（')[1]}</div>
                    </div>
                  );
                })()}

                {dashboardData.weather.localHourly && (
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#334155', marginBottom: '8px' }}>
                      📍 現在地の詳細予報（12時間）
                    </div>
                    <div style={{ display: 'flex', overflowX: 'auto', gap: '8px', paddingBottom: '8px', WebkitOverflowScrolling: 'touch' }}>
                      {dashboardData.weather.localHourly.map((lh, idx) => (
                        <div key={idx} style={{ minWidth: '50px', backgroundColor: '#f8fafc', padding: '8px 4px', borderRadius: '6px', textAlign: 'center', border: '1px solid #e2e8f0' }}>
                          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>{lh.time}</div>
                          <div style={{ fontSize: '20px', marginBottom: '4px' }}>{lh.info.icon}</div>
                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a' }}>{lh.temp}℃</div>
                          <div style={{ fontSize: '10px', color: '#3b82f6', marginTop: '2px' }}>{lh.pop}%</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'menu3' && (
              <div>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#334155', marginBottom: '10px' }}>📅 現在地の週間予報</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {dashboardData.weather.daily.map((day, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', borderBottom: idx !== 3 ? '1px solid #f1f5f9' : 'none', paddingBottom: '4px' }}>
                      <span style={{ width: '70px' }}>{day.date}</span>
                      <span style={{ width: '30px', textAlign: 'center' }}>{day.info.icon}</span>
                      <span style={{ color: '#ef4444', width: '35px', textAlign: 'right' }}>{Math.round(day.maxTemp)}℃</span>
                      <span style={{ color: '#3b82f6', width: '35px', textAlign: 'right' }}>{Math.round(day.minTemp)}℃</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'menu4' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '8px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#334155' }}>
                    {currentSlideData.offset === 0 ? '🕒 現在' : currentSlideData.offset < 0 ? `🕒 ${Math.abs(currentSlideData.offset)}時間前` : `🕒 ${currentSlideData.offset}時間後`} 
                    <span style={{fontSize: '12px', fontWeight: 'normal', color: '#64748b', marginLeft: '5px'}}>({currentSlideData.time})</span>
                  </span>
                  <span style={{ fontSize: '12px', color: trendMsg.color, fontWeight: 'bold' }}>{trendMsg.text}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f8fafc', padding: '15px 5px', borderRadius: '8px' }}>
                  <div style={{ textAlign: 'center', width: '28%' }}>
                    <div style={{ fontSize: '28px' }}>{currentSlideData.info.icon}</div>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '4px' }}>{currentSlideData.temp}℃</div>
                  </div>
                  <div style={{ textAlign: 'center', borderLeft: '1px solid #cbd5e1', paddingLeft: '5px', width: '36%' }}>
                    <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>ドローン(80m)</div>
                    <div style={{ fontSize: '22px', color: '#0f172a', transform: `rotate(${currentSlideData.windDir + 180}deg)`, transition: 'transform 0.3s ease', display: 'inline-block' }}>⬆</div>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '4px' }}>{currentSlideData.windSpeed} <span style={{fontSize: '9px'}}>m/s</span></div>
                  </div>
                  <div style={{ textAlign: 'center', borderLeft: '1px solid #cbd5e1', paddingLeft: '5px', width: '36%' }}>
                    <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>桜島火口(1000m)</div>
                    <div style={{ fontSize: '22px', color: '#e11d48', transform: `rotate(${currentSlideData.windDir1000m + 180}deg)`, transition: 'transform 0.3s ease', display: 'inline-block' }}>⬆</div>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', marginTop: '4px' }}>{currentSlideData.windSpeed1000m} <span style={{fontSize: '9px'}}>m/s</span></div>
                  </div>
                </div>

                <div style={{ marginTop: '10px', padding: '0 5px' }}>
                  <input type="range" min="0" max="6" step="1" value={timeIndex} onChange={(e) => setTimeIndex(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#64748b', marginTop: '5px' }}>
                    <span>-3h</span><span style={{ fontWeight: timeIndex === 3 ? 'bold' : 'normal', color: timeIndex === 3 ? '#0f172a' : '#64748b' }}>現在</span><span>+3h</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
