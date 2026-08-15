import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// データの形を厳密に定義（警告を完全に消すためのプロ仕様の設定です）
type DashboardData = {
  volcano: {
    hasAshfallWarning: boolean;
    ashfallGeoJson: {
      type: string;
      features: {
        type: string;
        properties: { volcano: string; amount: string };
        geometry: { type: string; coordinates: number[][][] };
      }[];
    };
    recentEruptions: { time: string; title: string }[];
  };

  weather: {
    current: {
      temp: number;
      humidity: number;
      info: { icon: string; text: string };
    };
    daily: {
      date: string;
      info: { icon: string; text: string };
      maxTemp: number;
      minTemp: number;
    }[];
  };
};

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [activeTab, setActiveTab] = useState('menu1');
  
  // 先ほど定義した DashboardData の型を適用（10行目の波線が消えます）
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);

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
      zoom: 10,
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
        const response = await fetch(`/data/dashboard_data.json?t=${timestamp}`);
        const data = await response.json();
        setDashboardData(data); 

        map.current.addSource('ashfall-data', {
          type: 'geojson',
          data: data.volcano.ashfallGeoJson,
        });

        map.current.addLayer({
          id: 'ashfall-fill',
          type: 'fill',
          source: 'ashfall-data',
          paint: {
            'fill-color': ['match', ['get', 'amount'], '多量', '#e11d48', 'やや多量', '#f97316', '少量', '#eab308', '#8d99ae'],
            'fill-opacity': 0.55,
          },
        });

        map.current.addLayer({
          id: 'ashfall-line',
          type: 'line',
          source: 'ashfall-data',
          paint: { 'line-color': '#475569', 'line-width': 2 },
        });
      } catch (err) {
        console.error("データの読み込みに失敗しました:", err);
      }
    });

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  const getLifeAdvice = () => {
    if (!dashboardData) return { laundry: 'データなし', car: 'データなし', color: '#64748b' };
    const { hasAshfallWarning } = dashboardData.volcano;
    const isRaining = dashboardData.weather.current.info.text.includes('雨');
    
    if (hasAshfallWarning) return { laundry: '部屋干し推奨（降灰あり）', car: '控えるべき（降灰あり）', color: '#e11d48' };
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

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, position: 'absolute', top: 0, left: 0 }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%', position: 'absolute', zIndex: 0 }} />
      
      <div style={{
        position: 'absolute', top: '20px', left: '20px', zIndex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '15px 20px',
        borderRadius: '12px', boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
        fontFamily: '"Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif',
        width: '320px'
      }}>
        <h1 style={{ margin: '0 0 15px 0', fontSize: '18px', color: '#1e293b', borderBottom: '2px solid #e2e8f0', paddingBottom: '10px' }}>
          🌋 桜島 生活・防災モニター
        </h1>

        <div style={{ display: 'flex', gap: '5px', marginBottom: '15px' }}>
          <button onClick={() => setActiveTab('menu1')} style={{ flex: 1, padding: '8px 4px', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', border: 'none', fontWeight: 'bold', backgroundColor: activeTab === 'menu1' ? '#3b82f6' : '#f1f5f9', color: activeTab === 'menu1' ? '#fff' : '#475569' }}>①降灰・生活</button>
          <button onClick={() => setActiveTab('menu2')} style={{ flex: 1, padding: '8px 4px', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', border: 'none', fontWeight: 'bold', backgroundColor: activeTab === 'menu2' ? '#3b82f6' : '#f1f5f9', color: activeTab === 'menu2' ? '#fff' : '#475569' }}>②現在天気</button>
          <button onClick={() => setActiveTab('menu3')} style={{ flex: 1, padding: '8px 4px', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', border: 'none', fontWeight: 'bold', backgroundColor: activeTab === 'menu3' ? '#3b82f6' : '#f1f5f9', color: activeTab === 'menu3' ? '#fff' : '#475569' }}>③週間予報</button>
        </div>

        {!dashboardData ? (
          <div style={{ minHeight: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
            最新データを取得中...
          </div>
        ) : (
          <div style={{ minHeight: '180px' }}>
            
            {activeTab === 'menu1' && (
              <div>
                <div style={{ marginBottom: '12px', backgroundColor: '#f8fafc', padding: '10px', borderRadius: '8px' }}>
                  <div style={{ fontSize: '14px', marginBottom: '6px', color: '#334155' }}>👕 <b>洗濯予想:</b> <span style={{ color: getLifeAdvice().color }}>{getLifeAdvice().laundry}</span></div>
                  <div style={{ fontSize: '14px', color: '#334155' }}>🚗 <b>洗車予想:</b> <span style={{ color: getLifeAdvice().color }}>{getLifeAdvice().car}</span></div>
                </div>

                <div style={{ marginBottom: '12px', backgroundColor: '#fff7ed', padding: '10px', borderRadius: '8px', border: '1px solid #ffedd5' }}>
                  <p style={{ margin: '0 0 6px 0', fontWeight: 'bold', fontSize: '13px', color: '#c2410c' }}>🌋 直近の噴火活動 (過去1時間)</p>
                  <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#431407', lineHeight: '1.5' }}>
                    {dashboardData.volcano.recentEruptions.length === 0 ? (
                      <li>噴火は観測されていません</li>
                    ) : (
                      dashboardData.volcano.recentEruptions.map((eruption, idx) => (
                        <li key={idx}>{eruption.time} {eruption.title}</li>
                      ))
                    )}
                  </ul>
                </div>

                <div style={{ fontSize: '14px', color: '#334155' }}>
                  <p style={{ margin: '0 0 6px 0', fontWeight: 'bold' }}>🕒 現在の降灰エリア</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#e11d48', opacity: 0.6, marginRight: '4px', border: '1px solid #475569' }}></span><span style={{ fontSize: '12px' }}>多量</span></div>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#f97316', opacity: 0.6, marginRight: '4px', border: '1px solid #475569' }}></span><span style={{ fontSize: '12px' }}>やや多量</span></div>
                    <div style={{ display: 'flex', alignItems: 'center' }}><span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: '#eab308', opacity: 0.6, marginRight: '4px', border: '1px solid #475569' }}></span><span style={{ fontSize: '12px' }}>少量</span></div>
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
                    <div style={{ backgroundColor: alert.bg, padding: '10px', borderRadius: '8px', border: `1px solid ${alert.color}40` }}>
                      <div style={{ fontSize: '14px', color: alert.color, fontWeight: 'bold' }}>⚠️ 熱中症: {alert.text.split('（')[0]}</div>
                      <div style={{ fontSize: '12px', color: alert.color, marginTop: '4px' }}>（{alert.text.split('（')[1]}</div>
                    </div>
                  );
                })()}
              </div>
            )}

            {activeTab === 'menu3' && (
              <div>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#334155', marginBottom: '10px' }}>📅 鹿児島市の週間予報</div>
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
          </div>
        )}
      </div>
    </div>
  );
}