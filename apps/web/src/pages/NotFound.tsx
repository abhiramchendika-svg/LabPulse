import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <div className="page-center">
      <div className="empty-card">
        <h1>There's no page at this address</h1>
        <p>Students join from the home page with a room code. Instructors start from their labs.</p>
        <div className="empty-actions">
          <Link className="btn btn-primary" to="/">
            Join a lab
          </Link>
          <Link className="btn" to="/teach">
            Instructor sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
