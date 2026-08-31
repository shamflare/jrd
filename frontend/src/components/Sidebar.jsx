import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Archive, Image, DollarSign, Settings, Menu, X, Landmark, MessageSquare, CalendarRange, LogOut, User, Building2, Users, Tags, History, GitCompareArrows } from 'lucide-react';
import { useAuth } from '../AuthContext.jsx';

const links = [
  { to: '/', icon: LayoutDashboard, label: 'الجرد' },
  { to: '/log', icon: History, label: 'السجل' },
  { to: '/currency', icon: DollarSign, label: 'العملات' },
  { to: '/prices', icon: Tags, label: 'أسعار الباقات' },
  { to: '/kontor-compare', icon: GitCompareArrows, label: 'مقارنة الأرقام' },
  { to: '/bank', icon: Landmark, label: 'البنك' },
  { to: '/whatsapp', icon: MessageSquare, label: 'واتسآب' },
  { to: '/archive', icon: Archive, label: 'الأرشيف' },
  { to: '/monthly', icon: CalendarRange, label: 'الجرد الشهري' },
  { to: '/photos', icon: Image, label: 'الصور' },
  { to: '/api-settings', icon: Settings, label: 'إعدادات API' },
];

const adminLinks = [
  { to: '/admin/tenants', icon: Building2, label: 'المستأجرون' },
  { to: '/admin/users', icon: Users, label: 'المستخدمون' },
];

export default function Sidebar() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { user, tenant, logout } = useAuth();

  // Close sidebar on route change (mobile)
  useEffect(() => { setOpen(false); }, [location.pathname]);

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 right-0 left-0 h-14 bg-emerald-800 text-white flex items-center justify-between px-4 z-50 shadow-lg">
        <button onClick={() => setOpen(!open)} className="p-1">
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
        <h1 className="text-lg font-bold">الجرد اليومي</h1>
        <div className="w-8" />
      </div>

      {/* Overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed right-0 top-0 h-full w-64 bg-gradient-to-b from-emerald-800 to-emerald-900 text-white shadow-xl z-50 flex flex-col
        transition-transform duration-300 ease-in-out
        ${open ? 'translate-x-0' : 'translate-x-full'}
        md:translate-x-0
      `}>
        <div className="p-6 border-b border-emerald-700">
          <h1 className="text-2xl font-bold text-center">الجرد اليومي</h1>
          <p className="text-emerald-300 text-sm text-center mt-1">نظام إدارة الحسابات</p>
        </div>

        <nav className="flex-1 py-4 overflow-y-auto">
          {links.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-6 py-3 mx-3 rounded-lg transition-all duration-200 ${
                  isActive
                    ? 'bg-white/20 text-white font-bold shadow-md'
                    : 'text-emerald-200 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <Icon size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
          {user?.role === 'admin' && (
            <>
              <div className="mt-4 mb-1 px-6 text-emerald-400 text-xs font-bold uppercase tracking-wider">إدارة الموقع</div>
              {adminLinks.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-6 py-3 mx-3 rounded-lg transition-all duration-200 ${
                      isActive
                        ? 'bg-purple-500/30 text-white font-bold shadow-md'
                        : 'text-emerald-200 hover:bg-white/10 hover:text-white'
                    }`
                  }
                >
                  <Icon size={20} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="p-4 border-t border-emerald-700 text-emerald-100 text-xs space-y-2">
          {user && (
            <>
              <div className="flex items-center gap-2 text-emerald-200">
                <User size={14} />
                <span className="truncate" title={user.email}>{user.email}</span>
              </div>
              {tenant && (
                <div className="text-emerald-300 text-[11px] truncate" title={tenant.name}>
                  {tenant.name}
                </div>
              )}
              <button
                onClick={logout}
                className="w-full flex items-center justify-center gap-2 bg-red-700/80 hover:bg-red-700 text-white py-1.5 rounded-md transition-colors"
              >
                <LogOut size={14} />
                <span>تسجيل الخروج</span>
              </button>
            </>
          )}
          <div className="text-center text-emerald-400 pt-1">JRD System v1.0</div>
        </div>
      </aside>
    </>
  );
}
