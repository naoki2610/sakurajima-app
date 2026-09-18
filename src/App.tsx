import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

interface DailyForecast {
  date: string;
  info: { icon: string; text: string };
  maxTemp: number;
  minTemp: number;
}
interface LocalHourlyForecast {
  time: string;
  temp: number;
  pop: number;
  info: { icon: string; text: string };
}
interface DashboardData {
  volcano: {
    hasAshfallWarning: boolean;
    ashfallGeoJson: any;
    recentEruptions: Array<{ time: string; title: string }>;
    validUntil?: string | null;
    directionText?: string | null;
  };
  weather: {
    current: { temp: number; humidity: number; info: { icon: string; text: string }; };
    daily: DailyForecast[];
    localHourly?: LocalHourlyForecast[];
    activeWarnings?: string[]; 
  };
  hourlyForecast?: Array<{
    time: string; offset: number; temp: number; windSpeed: number; windDir: number;
    windSpeed1000m: number; windDir1000m: number; pressure: number; info: { icon: string; text: string };
  }>;
}

function formatJST(timeStr: string): string {
  if (!timeStr || timeStr === '【システム警告】' || timeStr === '不明') return timeStr || '不明';
  try {
    const d = new Date(timeStr);
    if (isNaN(d.getTime())) return timeStr;
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${month}/${day} ${hours}:${minutes}`;
  } catch (e) { return timeStr; }
}

function getWeatherInfo(codeVal: any, tempVal?: any): { icon: string; text: string } {
  const code = Number(codeVal);
  const temp = parseFloat(tempVal);
  
  let isSnow = false;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) isSnow = true;
  if (isSnow && (isNaN(temp) || temp >= 10)) return { icon: '☔', text: '雨' };

  if (code === 0) return { icon: '☀️', text: '快晴' };
  if (code >= 1 && code <= 3) return { icon: '⛅', text: '晴れ/曇り' };
  if (code >= 45 && code <= 48) return { icon: '🌫️', text: '霧' };
  if (code >= 51 && code <= 67) return { icon: '☔', text: '雨' };
  if (isSnow) return { icon: '⛄', text: '雪' };
  if (code >= 80 && code <= 82) return { icon: '☔', text: 'にわか雨' };
  if (code >= 95) return { icon: '⚡', text: '雷雨' };
  return { icon: '☁️', text: '不明' };
}

function getVisibleWedgeGeoJson(directionText: string | null | undefined): any {
  if (!directionText) return null;
  const match = directionText.match(/(北北東|東北東|東南東|南南東|南南西|西南西|西北西|北北西|北東|南東|南西|北西|北|東|南|西)/);
  if (!match) return null;
  
  const mainDir = match[1];
  const dirs: Record<string, number> = {
    '北北東': 22.5, '東北東': 67.5, '東南東': 112.5, '南南東': 157.5,
    '南南西': 202.5, '西南西': 247.5, '西北西': 292.5, '北北西': 337.5,
    '北東': 45, '南東': 135, '南西': 225, '北西': 315,
    '北': 0, '東': 90, '南': 180, '西': 270
  };
  
  const angle = dirs[mainDir];
  if (angle === undefined) return null;

  const center = [130.659, 31.581]; 
  const radiusKm = 15; 
  const coords: number[][] = [[center[0], center[1]]]; 
  const latPerKm = 1 / 111.32;
  const lonPerKm = 1 / (111.32 * Math.cos(center[1] * Math.PI / 180));

  for (let i = angle + 35; i >= angle - 35; i -= 5) {
    const rad = i * Math.PI / 180;
    const dLat = radiusKm * Math.cos(rad) * latPerKm;
    const dLon = radiusKm * Math.sin(rad) * lonPerKm;
    coords.push([center[0] + dLon, center[1] + dLat]);
  }
  coords.push([center[0], center[1]]);

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature', 
      properties: { isFallback: true }, 
      geometry: { type: 'Polygon', coordinates: [coords] }
    }]
  };
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  
  const [mapLoaded, setMapLoaded] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<string>('menu1');
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [timeIndex, setTimeIndex] = useState<number>(3);
  const [isPanelOpen, setIsPanelOpen] = useState<boolean>(true);

  useEffect(() => {
    if (!mapContainer.current || map.current) return; 

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          'osm': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap',
          },
        },
        layers: [{ id: 'osm-layer', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 19 }],
      },
      center: [130.657, 31.580],
      zoom: 10,
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    if (navigator.geolocation) {
       map.current.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
    }

    map.current.on('load', () => setMapLoaded(true));

    return () => {
      if (map.current) { map.current.remove(); map.current = null; }
    };
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      const timestamp = new Date().getTime();
      try {
        const response = await fetch(`./data/dashboard_data.json?t=${timestamp}`);
        const data = await response.json();
        
        const fetchWeather = async (lat: number, lon: number) => {
            try {
                // 1. Open-Meteoから天気データの取得
                const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&hourly=temperature_2m,weather_code,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTokyo`);
                if (!weatherRes.ok) throw new Error("API failed");
                const wData = await weatherRes.json();
                
                const dailyForecasts: DailyForecast[] = [];
                if (wData?.daily?.time) {
                    for (let i = 0; i < 4; i++) {
                      if (!wData.daily.time[i]) continue;
                      const dObj = new Date(wData.daily.time[i]);
                      const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][dObj.getDay()];
                      const maxT = parseFloat(wData.daily.temperature_2m_max[i]);
                      dailyForecasts.push({
                        date: `${dObj.getMonth() + 1}/${dObj.getDate()} (${dayOfWeek})`,
                        info: getWeatherInfo(wData.daily.weather_code[i], maxT),
                        maxTemp: isNaN(maxT) ? 0 : Math.round(maxT), 
                        minTemp: Math.round(parseFloat(wData.daily.temperature_2m_min[i]) || 0)
                      });
                    }
                }

                const localHourlyData: LocalHourlyForecast[] = [];
                if (wData?.hourly?.time) {
                    const popArray = wData.hourly.precipitation_probability || [];
                    const nowTime = new Date().getTime();
                    const startIndex = wData.hourly.time.findIndex((t: string) => new Date(t).getTime() > nowTime - 3600000);
                    
                    if (startIndex !== -1) {
                      for (let i = 0; i < 12; i++) {
                        const idx = startIndex + i;
                        if (idx < wData.hourly.time.length) {
                          const dObj = new Date(wData.hourly.time[idx]);
                          const tTemp = parseFloat(wData.hourly.temperature_2m[idx]);
                          localHourlyData.push({
                            time: `${dObj.getHours()}:00`, 
                            temp: isNaN(tTemp) ? 0 : Math.round(tTemp),
                            pop: parseFloat(popArray[idx]) || 0,
                            info: getWeatherInfo(wData.hourly.weather_code[idx], tTemp)
                          });
                        }
                      }
                    }
                }

                const currTemp = Math.round((parseFloat(wData?.current?.temperature_2m) || 0) * 10) / 10;
                
                // 2. 【v5.9修正】気象庁APIデータの読み取りバグを修正し、日置市を追加
                let fetchedWarnings: string[] = [];
                try {
                    const jmaRes = await fetch('https://www.jma.go.jp/bosai/warning/data/warning/460000.json');
                    if (jmaRes.ok) {
                        const jmaData = await jmaRes.json();
                        const warningCodeMap: Record<string, string> = {
                            "02":"暴風警報", "03":"暴風雪警報", "04":"大雨警報", "05":"洪水警報",
                            "06":"波浪警報", "07":"高潮警報", "08":"大雪警報", "10":"大雨注意報",
                            "12":"大雪注意報", "13":"強風注意報", "14":"雷注意報", "15":"波浪注意報",
                            "16":"高潮注意報", "17":"濃霧注意報", "18":"乾燥注意報", "19":"なだれ注意報",
                            "20":"低温注意報", "21":"霜注意報", "22":"融雪注意報", "23":"着氷注意報",
                            "24":"着雪注意報", "32":"暴風特別警報", "33":"大雨特別警報", "34":"高潮特別警報",
                            "35":"波浪特別警報", "36":"大雪特別警報", "37":"暴風雪特別警報"
                        };
                        
                        // 【バグ修正】オブジェクト形式と配列形式の両方に確実に対応する処理
                        const dataObj = Array.isArray(jmaData) ? jmaData[0] : jmaData;
                        const areaTypes = dataObj?.areaTypes || [];
                        const class20s = areaTypes.find((a: any) => a.areaType === 'class20s')?.areas || [];
                        
                        // 鹿児島市(4620100) と 日置市(4621600) の両方を監視
                        const targetCodes = ['4620100', '4621600']; 
                        const activeSet = new Set<string>();
                        
                        class20s.forEach((area: any) => {
                            if (targetCodes.includes(area.code) && area.warnings) {
                                area.warnings.forEach((w: any) => {
                                    // 解除・発表なし以外のステータス（「発表」「継続」など）を拾う
                                    if (w.status !== '解除' && w.status !== '発表警報・注意報はなし') {
                                        const name = warningCodeMap[w.code];
                                        if (name) activeSet.add(name);
                                    }
                                });
                            }
                        });
                        
                        fetchedWarnings = Array.from(activeSet);
                    }
                } catch (e) {
                    console.error("気象庁データの取得に失敗しました", e);
                }

                setDashboardData({
                  ...data,
                  weather: { 
                    current: { temp: currTemp, humidity: parseFloat(wData?.current?.relative_humidity_2m) || 0, info: getWeatherInfo(wData?.current?.weather_code, currTemp) }, 
                    daily: dailyForecasts, 
                    localHourly: localHourlyData,
                    activeWarnings: fetchedWarnings
                  }
                });
            } catch (e) { setDashboardData(data); }
        };

        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => fetchWeather(pos.coords.latitude, pos.coords.longitude), 
            () => fetchWeather(31.628, 130.396), { timeout: 5000 }
          );
        } else {
          fetchWeather(31.628, 130.396);
        }
      } catch (err) { console.error("データ読込エラー", err); }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (!mapLoaded || !map.current || !dashboardData) return;

    const visibleWedge = getVisibleWedgeGeoJson(dashboardData.volcano.directionText);
    const renderGeoJson = visibleWedge || dashboardData.volcano.ashfallGeoJson;

    if (renderGeoJson && renderGeoJson.features && renderGeoJson.features.length > 0) {
      if (!map.current.getSource('v59-wedge-source')) {
        map.current.addSource('v59-wedge-source', { type: 'geojson', data: renderGeoJson });
        
        map.current.addLayer({
          id: 'v59-wedge-fill',
          type: 'fill',
          source: 'v59-wedge-source',
          paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.45 }
        });

        map.current.addLayer({
          id: 'v59-wedge-line',
          type: 'line',
          source: 'v59-wedge-source',
          paint: { 'line-color': '#991b1b', 'line-width': 3, 'line-dasharray': [4, 4] }
        });
      } else {
        (map.current.getSource('v59-wedge-source') as maplibregl.GeoJSONSource).setData(renderGeoJson);
      }
    }
  }, [mapLoaded, dashboardData]);

  const getLifeAdvice = () => {
    if (!dashboardData) return { laundry: 'データなし', car: 'データなし', color: '#64748b' };
    const { hasAshfallWarning } = dashboardData.volcano;
    const isRaining = dashboardData.weather.current.info.text.includes('雨');
    
    if (hasAshfallWarning) return { laundry: '部屋干し推奨（降灰警戒）', car: '控えるべき（降灰警戒）', color: '#e11d48' };
    if (isRaining) return { laundry: '部屋干し推奨（雨）', car: '控えるべき（雨）', color: '#3b82f6' };
    return { laundry: '外干しOK', car: '洗車日和', color: '#16a34a' };
  };

  const getHeatstrokeAlert = (temp: number) => {
    if (temp >= 35) return { text: '危険（運動中止）', color: '#9f1239', bg: '#ffe4e6' };
    if (temp >= 31) return { text: '厳重警戒（激しい運動中止）', color: '#be123c', bg: '#fff1f2' };
    if (temp >= 28) return { text: '警戒（積極的に休息を）', color: '#c2410c', bg: '#fff7ed' };
    if (temp >= 25) return { text: '注意（こまめな水分補給）', color: '#b45309', bg: '#fef3c7' };
    return { text: 'ほぼ安全', color: '#0f766e', bg: '#f0fdf4' };
  };

  const fallbackHourly = Array.from({ length: 7 }).map((_, i) => ({ time: `12:00`, offset: i - 3, temp: 25, windSpeed: 3.5, windDir: 180 + i * 30, windSpeed1000m: 5.0, windDir1000m: 190 + i * 30, pressure: 1010, info: { icon: '🌤️', text: '晴れ' } }));
  const hourlyData = dashboardData?.hourlyForecast || fallbackHourly;
  const currentSlideData = hourlyData[timeIndex] || fallbackHourly[3];
  const prevPressure = timeIndex > 0 ? (hourlyData[timeIndex - 1]?.pressure || currentSlideData.pressure) : currentSlideData.pressure;
  const pressureDiff = currentSlideData.pressure - prevPressure;
  let trendMsg = { text: "気圧安定", color: '#10b981' };
  if (pressureDiff <= -1.0) trendMsg = { text: "気圧低下中（突風注意）", color: '#ef4444' };
  if (pressureDiff >= 1.0) trendMsg = { text: "気圧上昇中", color: '#3b82f6' };

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, position: 'absolute', top: 0, left: 0 }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%', position: 'absolute', zIndex: 0 }} />
      
      <div style={{
        position: 'absolute', top: '20px', left: '20px', zIndex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.85)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        padding: '15px 20px', borderRadius: '12px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
        fontFamily: '"Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
        width: '330px', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', transition: 'all 0.3s ease-in-out'
      }}>
        
        <div style={{ 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: isPanelOpen ? '15px' : '0', 
          borderBottom: isPanelOpen ? '2px solid #e2e8f0' : 'none', 
          paddingBottom: isPanelOpen ? '10px' : '0' 
        }}>
          <h1 style={{ margin: 0, fontSize: '18px', color: '#1e293b' }}>
            🌋 桜島 生活・防災モニター <span style={{fontSize: '12px', color: '#ef4444', fontWeight: 'bold', marginLeft: '5px'}}>v5.9</span>
          </h1>
          <button 
            onClick={() => setIsPanelOpen(!isPanelOpen)}
            style={{ 
              background: '#f1f5f9', border: 'none', borderRadius: '20px', 
              padding: '6px 12px', fontSize: '12px', fontWeight: 'bold', 
              color: '#475569', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
            }}
          >
            {isPanelOpen ? '▼ 閉じる' : '▲ 開く'}
          </button>
        </div>

        {isPanelOpen && (
          <div style={{ overflowY: 'auto', flex: 1, paddingRight: '5px' }}>
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
                      <div style={{ marginBottom: '12px', backgroundColor: 'rgba(254, 242, 242, 0.9)', padding: '12px', borderRadius: '8px', border: '2px solid #dc2626', boxShadow: '0 2px 4px rgba(220, 38, 38, 0.2)' }}>
                        <div style={{ fontWeight: 'bold', color: '#b91c1c', fontSize: '15px', marginBottom: '4px' }}>
                          ⚠️ 降灰警戒方向: {dashboardData.volcano.directionText}
                        </div>
                        <div style={{ fontSize: '11px', color: '#991b1b', lineHeight: '1.4' }}>
                           ※地図上の半透明の扇形は目安です。この方向では屋外作業、UAVフライト、洗濯・洗車などの生活判断に十分警戒してください。
                        </div>
                      </div>
                    )}
                    <div style={{ marginBottom: '12px', backgroundColor: 'rgba(248, 250, 252, 0.9)', padding: '10px', borderRadius: '8px' }}>
                      <div style={{ fontSize: '14px', marginBottom: '6px', color: '#334155' }}>👕 <b>洗濯予想:</b> <span style={{ color: getLifeAdvice().color }}>{getLifeAdvice().laundry}</span></div>
                      <div style={{ fontSize: '14px', color: '#334155' }}>🚗 <b>洗車予想:</b> <span style={{ color: getLifeAdvice().color }}>{getLifeAdvice().car}</span></div>
                    </div>
                    <div style={{ marginBottom: '12px', backgroundColor: 'rgba(255, 247, 237, 0.9)', padding: '10px', borderRadius: '8px', border: '1px solid #ffedd5' }}>
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
                    {/* 【v5.9】鹿児島市・日置市の気象警報・注意報エリア */}
                    <div style={{ marginBottom: '15px', backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '12px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                      <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#334155', marginBottom: '8px' }}>
                        🚨 鹿児島市・日置市の気象警報・注意報
                      </div>
                      {dashboardData.weather.activeWarnings && dashboardData.weather.activeWarnings.length > 0 ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {dashboardData.weather.activeWarnings.map((w, idx) => (
                            <span key={idx} style={{ 
                              padding: '4px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold',
                              backgroundColor: w.includes('特別警報') ? '#4c0519' : w.includes('警報') ? '#dc2626' : '#eab308',
                              color: w.includes('特別警報') || w.includes('警報') ? '#fff' : '#451a03',
                              border: w.includes('注意報') ? '1px solid #ca8a04' : 'none'
                            }}>
                              {w}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: '12px', color: '#64748b' }}>現在、発表されている警報・注意報はありません。</div>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '15px', backgroundColor: 'rgba(240, 249, 255, 0.9)', padding: '15px', borderRadius: '8px' }}>
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
                            <div key={idx} style={{ minWidth: '50px', backgroundColor: 'rgba(248, 250, 252, 0.9)', padding: '8px 4px', borderRadius: '6px', textAlign: 'center', border: '1px solid #e2e8f0' }}>
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

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(248, 250, 252, 0.9)', padding: '15px 5px', borderRadius: '8px' }}>
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
        )}
      </div>
    </div>
  );
}
