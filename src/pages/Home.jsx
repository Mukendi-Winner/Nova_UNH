import AppBrand from '../components/AppBrand.jsx'
import EntityCard from '../components/EntityCard.jsx'

function Home({ entities }) {
  return (
    <main className="mobile-shell home-page">
      <AppBrand />

      <section className="home-intro" aria-label="Vue d'ensemble">
        <p>Guide universitaire</p>
        <h1>Explore l'UNH par entite</h1>
        <span>
          Retrouve rapidement les informations sur les facultes, les batiments et les
          espaces importants du campus.
        </span>
      </section>

      <section className="entities-list" aria-label="Entites disponibles">
        {entities.map((entity) => (
          <EntityCard key={entity.slug} entity={entity} />
        ))}
      </section>
    </main>
  )
}

export default Home
