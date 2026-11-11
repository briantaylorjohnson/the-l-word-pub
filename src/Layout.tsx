import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function Layout() {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <Outlet />
        <footer className="main-foot">
          © {new Date().getFullYear()} The L Word Guild. All rights reserved for content not owned by other
          entities.
        </footer>
      </main>
    </div>
  );
}
