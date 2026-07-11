import { NavLink } from 'react-router-dom';
import { Video, Disc, PlaySquare, Cpu } from 'lucide-react';

const navItems = [
  { to: '/live', icon: Video, label: 'Live View' },
  { to: '/recording', icon: Disc, label: 'Recording' },
  { to: '/playback', icon: PlaySquare, label: 'Playback' },
  { to: '/models', icon: Cpu, label: 'Models' },
];

const SidebarNav = () => {
  return (
    <aside className="w-60 border-r border-border bg-sidebar p-4">
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200 ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
};

export default SidebarNav;
