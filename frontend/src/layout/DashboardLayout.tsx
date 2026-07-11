import { Outlet } from 'react-router-dom';
import TopBar from '../components/TopBar';
import SidebarNav from '../components/SidebarNav';

const DashboardLayout = () => {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      <div className="flex flex-1">
        <SidebarNav />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;
