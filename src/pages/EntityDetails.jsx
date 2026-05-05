import { Link, useParams } from 'react-router-dom'
import { EntityImage } from '../components/EntityCard.jsx'
import UniversityAssistant from '../components/UniversityAssistant.jsx'

function EntityDetails({ entities }) {
  const { slug } = useParams()
  const entity = entities.find((item) => item.slug === slug)

  if (!entity) {
    return (
      <main className="mobile-shell empty-page">
        <Link className="back-button back-button--plain" to="/" aria-label="Retour">
          <span aria-hidden="true">←</span>
        </Link>
        <h1>Entite introuvable</h1>
      </main>
    )
  }

  return (
    <main className="mobile-shell details-page">
      <EntityImage entity={entity} className="details-hero" />
      <Link className="back-button" to="/" aria-label="Retour a l'accueil">
        <span aria-hidden="true">←</span>
      </Link>

      <section className="details-panel">
        <p className="place-type">{entity.type}</p>
        <h1>{entity.nom}</h1>
        <p className="details-description">{entity.description}</p>
      </section>

      <UniversityAssistant entity={entity} />
    </main>
  )
}

export default EntityDetails
