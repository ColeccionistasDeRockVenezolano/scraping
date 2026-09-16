import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Layout } from "./components/Layout";
import { SearchPage } from "./pages/SearchPage";
import { ArtistsListPage } from "./pages/ArtistsListPage";
import { ArtistDetailPage } from "./pages/ArtistDetailPage";
import { AlbumsListPage } from "./pages/AlbumsListPage";
import { AlbumDetailPage } from "./pages/AlbumDetailPage";
import { PersonsListPage } from "./pages/PersonsListPage";
import { PersonDetailPage } from "./pages/PersonDetailPage";
import { PersonDuplicatesPage } from "./pages/PersonDuplicatesPage";
import { OrganizationsListPage } from "./pages/OrganizationsListPage";
import { OrganizationDetailPage } from "./pages/OrganizationDetailPage";
import { ReviewQueueDetailPage } from "./pages/ReviewQueueDetailPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { CurationLayout } from "./pages/CurationLayout";
import { CurationOverviewPage } from "./pages/CurationOverviewPage";
import { CurationFindingsPage } from "./pages/CurationFindingsPage";

/** Enlaces viejos (/revision/:id) siguen llevando a la revisión. */
function LegacyReviewRedirect() {
  const { id } = useParams();
  return <Navigate to={`/curaduria/revision/${id ?? ""}`} replace />;
}

export function App() {
  return (
    <Layout>
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
        </Route>
        <Route path="/revision" element={<Navigate to="/curaduria" replace />} />
        <Route path="/revision/:id" element={<LegacyReviewRedirect />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
