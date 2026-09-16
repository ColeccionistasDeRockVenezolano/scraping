import { Route, Routes } from "react-router-dom";
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
import { ReviewQueueListPage } from "./pages/ReviewQueueListPage";
import { ReviewQueueDetailPage } from "./pages/ReviewQueueDetailPage";
import { NotFoundPage } from "./pages/NotFoundPage";

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
        <Route path="/personas/duplicados" element={<PersonDuplicatesPage />} />
        <Route path="/personas/:id" element={<PersonDetailPage />} />
        <Route path="/organizaciones" element={<OrganizationsListPage />} />
        <Route path="/organizaciones/:id" element={<OrganizationDetailPage />} />
        <Route path="/revision" element={<ReviewQueueListPage />} />
        <Route path="/revision/:id" element={<ReviewQueueDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
