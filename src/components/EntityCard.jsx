import { Link } from 'react-router-dom'

function EntityCard({ entity, onSelect }) {
  const content = (
    <>
      <EntityImage entity={entity} className="entity-card__image" />
      <div className="entity-card__content">
        <p className="entity-card__type">{entity.type}</p>
        <h2>{entity.nom}</h2>
        <p>{entity.description}</p>
      </div>
    </>
  )

  if (onSelect) {
    return (
      <button className="entity-card" type="button" onClick={() => onSelect(entity.slug)}>
        {content}
      </button>
    )
  }

  return (
    <Link className="entity-card" to={`/entites/${entity.slug}`}>
      {content}
    </Link>
  )
}

export function EntityImage({ entity, className = '' }) {
  const hasRealImage = entity.img && !entity.img.endsWith('/x')

  if (hasRealImage) {
    return <img className={className} src={entity.img} alt={entity.nom} />
  }

  return (
    <div className={`${className} entity-image-fallback`} aria-label={entity.nom} role="img">
      <span>{entity.type}</span>
    </div>
  )
}

export default EntityCard
