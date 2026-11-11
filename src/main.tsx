import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
// Icon font by Nucleo (nucleoapp.com), used under the Nucleo license — see THIRD_PARTY_NOTICES.md
import './assets/plugins/nucleo/css/nucleo.css'
import '@aws-amplify/ui-react/styles.css'
import './assets/css/sanctum.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
