import { NavLink, useNavigate } from "react-router";

import { useApi } from "../api/ApiContext";
import { useAuth } from "../auth/AuthContext";

export function Header() {
  const { user, signOut } = useAuth();
  const api = useApi();
  const navigate = useNavigate();

  return (
    <header className="header">
      <div className="header-inner">
        <NavLink to="/runs" className="brand">
          AutoAce
        </NavLink>
        {api.mode === "mock" && (
          <span className="badge" title="Data is simulated in this browser tab; nothing is sent to the API">
            Mock API
          </span>
        )}
        <nav aria-label="Main" className="nav">
          <NavLink to="/new">New batch</NavLink>
          <NavLink to="/runs" end={false}>
            Results
          </NavLink>
        </nav>
        <div className="user">
          <span className="user-email" title={user?.email}>
            {user?.email}
          </span>
          <button
            type="button"
            className="button button-quiet"
            onClick={async () => {
              await signOut();
              navigate("/login", { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
