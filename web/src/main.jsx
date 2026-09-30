import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import './mobile.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(<App />)

// Keep the app itself available offline (see web/sw.template.js). Relative, so /laptop/ and /mobile/
// each get their own worker and cache.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline app shell unavailable', e))
}
