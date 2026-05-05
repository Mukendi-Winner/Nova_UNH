import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import places from './data.js'
import EntityDetails from './pages/EntityDetails.jsx'
import Home from './pages/Home.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home entities={places} />} />
      <Route path="/entites/:slug" element={<EntityDetails entities={places} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
