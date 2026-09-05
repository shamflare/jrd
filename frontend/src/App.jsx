import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './AuthContext.jsx';
import RequireAuth from './RequireAuth.jsx';
import Sidebar from './components/Sidebar.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Log from './pages/Log.jsx';
import Archive from './pages/Archive.jsx';
import MonthlyArchive from './pages/MonthlyArchive.jsx';
import Photos from './pages/Photos.jsx';
import Currency from './pages/Currency.jsx';
import ApiSettings from './pages/ApiSettings.jsx';
import Bank from './pages/Bank.jsx';
import WhatsApp from './pages/WhatsApp.jsx';
import Prices from './pages/Prices.jsx';
import KontorCompare from './pages/KontorCompare.jsx';
import Login from './pages/Login.jsx';
import IslamOtp from './pages/IslamOtp.jsx';
import IslamSource from './pages/IslamSource.jsx';
import AdminTenants from './pages/AdminTenants.jsx';
import AdminUsers from './pages/AdminUsers.jsx';

function ProtectedShell() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-4 md:p-6 md:mr-64 mt-14 md:mt-0 overflow-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/log" element={<Log />} />
          <Route path="/archive" element={<Archive />} />
          <Route path="/monthly" element={<MonthlyArchive />} />
          <Route path="/photos" element={<Photos />} />
          <Route path="/currency" element={<Currency />} />
          <Route path="/api-settings" element={<ApiSettings />} />
          <Route path="/bank" element={<Bank />} />
          <Route path="/whatsapp" element={<WhatsApp />} />
          <Route path="/prices" element={<Prices />} />
          <Route path="/kontor-compare" element={<KontorCompare />} />
          <Route path="/islam-source" element={<IslamSource />} />
          <Route path="/admin/tenants" element={<RequireAuth adminOnly><AdminTenants /></RequireAuth>} />
          <Route path="/admin/users" element={<RequireAuth adminOnly><AdminUsers /></RequireAuth>} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* صفحة عامّة عمداً — خارج RequireAuth (سجلّ أكواد أكبنك). */}
          <Route path="/islam" element={<IslamOtp />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <ProtectedShell />
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

