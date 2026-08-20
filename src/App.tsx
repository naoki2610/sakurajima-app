// (一部抜粋・変更箇所のみコード記述)
// useEffect内でのデータ取得部分を書き換えます

  useEffect(() => {
    // ... (マップ初期化処理はそのまま) ...

    map.current.on('load', async () => {
      if (!map.current) return;
      
      const timestamp = new Date().getTime();
      try {
        // 1. 固定の火山データを取得
        const response = await fetch(`./data/dashboard_data.json?t=${timestamp}`);
        const data = await response.json();
        setDashboardData(data); 

        // 2. 現在地の天気を取得（ブラウザ機能を使用）
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            try {
              const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia%2FTokyo`);
              const weatherData = await weatherRes.json();
              
              // 取得した天気で現在表示を上書き
              setDashboardData(prev => prev ? {
                ...prev,
                weather: {
                  ...prev.weather,
                  current: {
                    temp: Math.round(weatherData.current.temperature_2m),
                    humidity: weatherData.current.relative_humidity_2m,
                    info: getWeatherInfo(weatherData.current.weather_code)
                  }
                }
              } : null);
            } catch (e) {
              console.warn("現在地の天気取得に失敗しました。デフォルトを表示します。");
            }
          });
        }
        
        // ... (地図のレイヤー追加処理などはそのまま) ...
