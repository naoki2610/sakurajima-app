import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
// index.cssの読み込みを一時的に消して完全に影響をなくします

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)