import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AuthProvider from "./context/AuthContext.jsx";
import ProtectedRoute from "./components/ProtectedRoute";

const Landing = lazy(() => import("./pages/Landing"));
const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const DashboardLayout = lazy(() => import("./layouts/DashboardLayout"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Projects = lazy(() => import("./pages/Projects"));
const Deployments = lazy(() => import("./pages/Deployments"));
const Settings = lazy(() => import("./pages/Settings"));
const DeploymentPlan = lazy(() => import("./pages/DeploymentPlan"));
const DockerPreview = lazy(() => import("./pages/DockerPreview"));
const InfrastructurePreview = lazy(() => import("./pages/InfrastructurePreview"));
const DeploymentConsole = lazy(() => import("./pages/DeploymentConsole"));
const NotFound = lazy(() => import("./pages/NotFound"));

function LoadingScreen() {
  return <div className="flex min-h-screen items-center justify-center bg-[#050508] text-sm text-zinc-400">Loading SkyForge...</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/dashboard" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="projects" element={<Projects />} />
              <Route path="projects/:id/plan" element={<DeploymentPlan />} />
              <Route path="projects/:id/docker" element={<DockerPreview />} />
              <Route path="projects/:id/infrastructure" element={<InfrastructurePreview />} />
              <Route path="projects/:id/deploy" element={<DeploymentConsole />} />
              <Route path="deployments" element={<Deployments />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="/project/:id/plan" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<DeploymentPlan />} />
            </Route>
            <Route path="/project/:id/docker" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<DockerPreview />} />
            </Route>
            <Route path="/project/:id/infrastructure" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<InfrastructurePreview />} />
            </Route>
            <Route path="/project/:id/deploy" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<DeploymentConsole />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
