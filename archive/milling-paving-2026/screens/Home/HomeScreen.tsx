import { Link } from 'react-router-dom'
import './HomeScreen.css'

/**
 * The default landing screen — separate from Dashboard on purpose. This is
 * what the app opens to every time: nothing but the entry activities
 * themselves, ordered by expected frequency of use (Milling first, Paving
 * second). No stats, no contract data, nothing to read — just where to tap
 * to start logging something. Anyone who wants to check overall progress
 * instead goes to Dashboard/Tracker via the persistent nav.
 *
 * Paving Stage 1 (width entry) is live now — its row is a real link, same
 * as Milling's.
 */
export function HomeScreen() {
  return (
    <div className="home-screen">
      <Link to="/milling" className="home-row home-row-active">
        <span className="home-row-label">Milling</span>
      </Link>

      <Link to="/paving" className="home-row home-row-active">
        <span className="home-row-label">Paving</span>
      </Link>
    </div>
  )
}
