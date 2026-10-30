import { Link } from "react-router";

import { EmptyState } from "../components/States";

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <p>
        <Link to="/runs">Go to your results</Link>
      </p>
    </EmptyState>
  );
}
