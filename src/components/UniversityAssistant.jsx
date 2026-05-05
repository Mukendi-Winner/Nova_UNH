import { useRef, useState } from 'react'
import { startUniversityGuide } from '../services/universityGuide.js'

function UniversityAssistant({ entity }) {
  const [guideStatus, setGuideStatus] = useState('idle')
  const guideSessionRef = useRef(null)

  const handleGuideClick = async () => {
    if (guideStatus === 'connecting') {
      return
    }

    if (guideSessionRef.current) {
      guideSessionRef.current.stop()
      guideSessionRef.current = null
      setGuideStatus('idle')
      return
    }

    setGuideStatus('connecting')

    guideSessionRef.current = await startUniversityGuide(entity, {
      onStatus: setGuideStatus,
      onLog: (message, detail) => console.log(`[Nova UNH] ${message}`, detail || ''),
      onClose: () => {
        guideSessionRef.current = null
      },
    })
  }

  const guideLabel = {
    idle: "parler a l'assistant UNH",
    connecting: "connexion a l'assistant...",
    listening: "arreter l'assistant",
    answering: "l'assistant repond...",
    speaking: "l'assistant parle...",
    error: "reessayer avec l'assistant",
  }[guideStatus]

  return (
    <section className="assistant-panel" aria-label="Assistant universitaire">
      <div className="assistant-heading">
        <span className="assistant-mark" aria-hidden="true">UNH</span>
        <div>
          <p>Assistant de l'universite</p>
          <h2>Discussion sur {entity.nom}</h2>
        </div>
      </div>
      <button
        className={`guide-button guide-button--${guideStatus}`}
        type="button"
        onClick={handleGuideClick}
        disabled={guideStatus === 'connecting'}
      >
        <span className="guide-status-dot" aria-hidden="true"></span>
        <span>{guideLabel}</span>
      </button>
    </section>
  )
}

export default UniversityAssistant
