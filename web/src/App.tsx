import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RouteFallback } from "./components/Skeletons";
import { NotFoundPage } from "./pages/NotFoundPage";

// Cada página viaja en su propio chunk (React.lazy): la carga inicial solo trae
// el marco y la página abierta; al navegar, el chunk llega bajo un skeleton de
// fallback (RouteFallback). NotFoundPage queda eager: es diminuta y responde
// cualquier URL desconocida.
const SearchPage = lazy(() => import("./pages/SearchPage").then((module) => ({ default: module.SearchPage })));
const ArtistsListPage = lazy(() => import("./pages/ArtistsListPage").then((module) => ({ default: module.ArtistsListPage })));
const ArtistDetailPage = lazy(() => import("./pages/ArtistDetailPage").then((module) => ({ default: module.ArtistDetailPage })));
const AlbumsListPage = lazy(() => import("./pages/AlbumsListPage").then((module) => ({ default: module.AlbumsListPage })));
const AlbumDetailPage = lazy(() => import("./pages/AlbumDetailPage").then((module) => ({ default: module.AlbumDetailPage })));
const PersonsListPage = lazy(() => import("./pages/PersonsListPage").then((module) => ({ default: module.PersonsListPage })));
const PersonDetailPage = lazy(() => import("./pages/PersonDetailPage").then((module) => ({ default: module.PersonDetailPage })));
const PersonDuplicatesPage = lazy(() => import("./pages/PersonDuplicatesPage").then((module) => ({ default: module.PersonDuplicatesPage })));
const OrganizationsListPage = lazy(() => import("./pages/OrganizationsListPage").then((module) => ({ default: module.OrganizationsListPage })));
const OrganizationDetailPage = lazy(() => import("./pages/OrganizationDetailPage").then((module) => ({ default: module.OrganizationDetailPage })));
const ReviewQueueDetailPage = lazy(() => import("./pages/ReviewQueueDetailPage").then((module) => ({ default: module.ReviewQueueDetailPage })));
const CurationLayout = lazy(() => import("./pages/CurationLayout").then((module) => ({ default: module.CurationLayout })));
const CurationOverviewPage = lazy(() => import("./pages/CurationOverviewPage").then((module) => ({ default: module.CurationOverviewPage })));
const CurationFindingsPage = lazy(() => import("./pages/CurationFindingsPage").then((module) => ({ default: module.CurationFindingsPage })));
const CurationFixesPage = lazy(() => import("./pages/CurationFixesPage").then((module) => ({ default: module.CurationFixesPage })));
const CurationAutofixPage = lazy(() => import("./pages/CurationAutofixPage").then((module) => ({ default: module.CurationAutofixPage })));

/** Enlaces viejos (/revision/:id) siguen llevando a la revisión. */
function LegacyReviewRedirect() {
  const { id } = useParams();
  return <Navigate to={`/curaduria/revision/${id ?? ""}`} replace />;
}

export function App() {
  return (
    <Layout>
      {/* El marco (topbar + nav) no se suspende: solo la página en curso. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/artistas" element={<ArtistsListPage />} />
          <Route path="/artistas/:id" element={<ArtistDetailPage />} />
          <Route path="/discos" element={<AlbumsListPage />} />
          <Route path="/discos/:id" element={<AlbumDetailPage />} />
          <Route path="/personas" element={<PersonsListPage />} />
          <Route path="/personas/duplicados" element={<Navigate to="/curaduria/duplicados" replace />} />
          <Route path="/personas/:id" element={<PersonDetailPage />} />
          <Route path="/organizaciones" element={<OrganizationsListPage />} />
          <Route path="/organizaciones/:id" element={<OrganizationDetailPage />} />
          <Route path="/curaduria" element={<CurationLayout />}>
            <Route index element={<CurationOverviewPage />} />
            <Route path="categoria/:key" element={<CurationFindingsPage />} />
            <Route path="hallazgos" element={<CurationFindingsPage />} />
            {/* La cola de revisión vive ahora dentro de las categorías del detector. */}
            <Route path="revision" element={<Navigate to="/curaduria" replace />} />
            <Route path="revision/:id" element={<ReviewQueueDetailPage />} />
            <Route path="duplicados" element={<PersonDuplicatesPage />} />
            {/* Historial de lotes de corrección, con su deshacer (PLAN_CURADURIA E8.5). */}
            <Route path="correcciones" element={<CurationFixesPage />} />
            <Route path="correcciones/:batchId" element={<CurationFixesPage />} />
            {/* Lista blanca de la autocorrección, solo admin (PLAN_CURADURIA E10). */}
            <Route path="autocorreccion" element={<CurationAutofixPage />} />
          </Route>
          <Route path="/revision" element={<Navigate to="/curaduria" replace />} />
          <Route path="/revision/:id" element={<LegacyReviewRedirect />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
